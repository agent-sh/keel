// Files for the next message: picked on the phone, each read, a photo made
// fit for the model, and uploaded at once (POST /v1/upload), so Send carries
// only their ids. What is picked stays with its session until it is sent or
// removed, also when the session is left and opened again.
package dev.avifenesh.keel

import android.content.Context
import android.media.ExifInterface
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.LruCache
import android.webkit.MimeTypeMap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.scale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.util.UUID

/**
 * The words begun in each session's box, held for the app's life: a session left and opened again
 * (Back, a notification, the next waiting card) finds them where they were.
 */
object Unsent {
    val text = MutableStateFlow<Map<String, String>>(emptyMap())
    /** A send that failed, with its id, so the same words sent again are the same prompt (`Wire.sendId`). */
    data class NotSent(val words: String, val id: String, val key: String, val after: Double, val why: String)
    /** The failed sends the owner has not been shown yet: a screen left while its send went shows them when opened. */
    val notSent = MutableStateFlow<Map<String, NotSent>>(emptyMap())
    fun of(chat: String): String = text.value[chat].orEmpty()
    fun put(chat: String, words: String) = text.update { if (words.isEmpty()) it - chat else it + (chat to words) }
    fun reset() { text.value = emptyMap(); notSent.value = emptyMap() }
    /** A session that is gone (deleted, or not on the computer any more): its words go with it. */
    fun drop(chats: Set<String>) { if (chats.isEmpty()) return; text.update { it - chats }; notSent.update { it - chats } }
    /** The owner has been shown the failed send. */
    fun shown(chat: String) = notSent.update { it - chat }

    /**
     * A send of a session's box. Its words stop being a draft as it goes, so a screen left before
     * the daemon answers is not opened again on words a second Send would make a second prompt of.
     * It runs in `app`, not in the screen: leaving the screen does not cut it. Only a send that
     * failed brings its words back (unless the owner has begun others since), with why and its id.
     */
    fun send(app: CoroutineScope, chat: String, failed: NotSent, why: (Throwable) -> String, call: suspend () -> Unit): Deferred<Unit> {
        text.update { it - chat }
        notSent.update { it - chat }
        return app.async {
            try { call() } catch (e: CancellationException) { throw e } catch (e: Throwable) {
                if (of(chat).isEmpty()) put(chat, failed.words)
                notSent.update { it + (chat to failed.copy(why = why(e))) }
                throw e
            }
        }
    }
}

/** Where a picked file stands: being read and made fit, going up, stored on the computer, or not sent. */
enum class Up { READING, UPLOADING, READY, FAILED }

data class Picked(
    val key: String, val name: String, val mime: String, val size: Long, val state: Up,
    val thumb: ImageBitmap? = null, val upload: Upload? = null, val error: String = "",
    /** Where it was picked from, kept for Try again. */
    val uri: Uri? = null, val picked: String = name, val pickedMime: String = mime, val pickedSize: Long? = null,
) {
    val photo get() = mime.startsWith("image/")
    val busy get() = state == Up.READING || state == Up.UPLOADING
}

object Attach {
    /** By session: what is picked for its next message, in the order picked. */
    val pending = MutableStateFlow<Map<String, List<Picked>>>(emptyMap())
    @Volatile private var limits: Me? = null
    // Photos are decoded two at a time: a dozen picked at once must not hold a dozen full-size bitmaps.
    private val decoding = Semaphore(2)

    fun reset() { pending.value = emptyMap(); limits = null; Media.clear(); Unsent.reset() }

    fun remove(chat: String, key: String) = pending.update { m -> m + (chat to m[chat].orEmpty().filter { it.key != key }) }
    fun clear(chat: String) = pending.update { it - chat }
    /** A send was stored: its files leave the row; any picked since stay for the next one. */
    fun sent(chat: String, files: List<Upload>) = files.map { it.id }.toSet().let { ids -> pending.update { m -> m + (chat to m[chat].orEmpty().filter { it.upload?.id !in ids }) } }
    /** The same, for a send known by its key (Wire.sendKey): one that arrived with the stream. */
    fun sent(chat: String, key: String) = Wire.keyFiles(key).let { ids -> sent(chat, ready(chat).filter { it.id in ids }) }
    /** What a send carries: the files stored on the computer, in the order picked. */
    fun ready(chat: String): List<Upload> = pending.value[chat].orEmpty().mapNotNull { if (it.state == Up.READY) it.upload else null }

    private fun put(chat: String, p: Picked) = pending.update { m -> m + (chat to m[chat].orEmpty() + p) }
    private fun change(chat: String, key: String, f: (Picked) -> Picked) =
        pending.update { m -> m[chat]?.let { l -> m + (chat to l.map { if (it.key == key) f(it) else it }) } ?: m }
    private fun fail(chat: String, key: String, why: String) = change(chat, key) { it.copy(state = Up.FAILED, error = why) }

    // What the daemon takes. Nothing is read before it says: a file cannot be held to a limit nobody knows.
    private suspend fun limits(): Me = limits ?: Hub.me().also { limits = it }

    /** Files the owner picked for a session's next message: each is read and uploaded on its own. */
    fun add(ctx: Context, chat: String, uris: List<Uri>) {
        val app = ctx.applicationContext
        for (uri in uris) {
            val (given, size) = meta(app, uri)
            val mime = app.contentResolver.getType(uri)?.lowercase()
                ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(given.substringAfterLast('.', "").lowercase())
                ?: "application/octet-stream"
            // A photo the picker names by its media id is named by when it was taken.
            val id = uri.lastPathSegment
            // The photo picker's URIs: content://media/picker/... and content://media/picker_get_content/...
            val picker = uri.authority == "media" && uri.pathSegments.firstOrNull()?.startsWith("picker") == true
            val name = if (Wire.byMediaId(given, mime, id, picker)) Wire.pickedName(given, mime, id, taken(app, uri), picker = picker) else given
            val key = UUID.randomUUID().toString()
            put(chat, Picked(key, name, mime, size ?: 0, Up.READING, uri = uri, pickedSize = size))
            Hub.scope.launch { take(app, chat, key, uri, name, mime, size) }
        }
    }

    /** A pick that failed, read and sent again from where it was picked. */
    fun retry(ctx: Context, chat: String, key: String) {
        val p = pending.value[chat]?.firstOrNull { it.key == key && it.state == Up.FAILED } ?: return
        val uri = p.uri ?: return
        change(chat, key) { it.copy(state = Up.READING, error = "", name = p.picked, mime = p.pickedMime) }
        Hub.scope.launch { take(ctx.applicationContext, chat, key, uri, p.picked, p.pickedMime, p.pickedSize) }
    }

    private suspend fun take(ctx: Context, chat: String, key: String, uri: Uri, name: String, mime: String, size: Long?) {
        try {
            val me = try { limits() } catch (e: CancellationException) { throw e } catch (e: Exception) {
                return fail(chat, key, "$name: the computer did not say how large a file may be (${e.message ?: e.javaClass.simpleName}). Try again.")
            }
            val got = prepare(ctx, uri, name, mime, size, me)
            if (got.refused.isNotEmpty()) return fail(chat, key, got.refused)
            val bytes = got.bytes!!; val type = got.mime; val file = got.name; val thumb = got.thumb
            change(chat, key) { it.copy(name = file, mime = type, size = bytes.size.toLong(), thumb = thumb, state = Up.UPLOADING) }
            val u = Upload.of(Api.postBytes(Wire.uploadPath(file, type), bytes, type))
            if (u.id.isBlank()) return fail(chat, key, "$file: the computer sent no id for it. Try again.")
            change(chat, key) { it.copy(state = Up.READY, upload = u, mime = u.mime.ifBlank { type }, size = u.size.takeIf { s -> s > 0 } ?: it.size) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            fail(chat, key, "$name: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    /** What goes up for one pick: its bytes, type and name, its thumbnail; or why it does not. */
    class Prepared(val bytes: ByteArray?, val mime: String, val name: String, val thumb: ImageBitmap?, val refused: String = "")

    /**
     * A pick made ready to go up. A photo is decoded from where it was picked, never read whole: it costs
     * its thumbnail and, when it is written again, its copy. Anything that goes as picked is refused by
     * its size before it is read, and read no further than the limit.
     */
    suspend fun prepare(ctx: Context, uri: Uri, name: String, mime: String, size: Long?, me: Me): Prepared {
        val max = me.maxBytes
        var bytes: ByteArray? = null; var type = mime; var file = name; var thumb: ImageBitmap? = null
        if (mime.startsWith("image/")) {
            val p = decoding.withPermit { withContext(Dispatchers.Default) { runCatching { photo(ctx, uri, mime, me) }.getOrNull() } }
            if (p != null) { thumb = p.thumb; if (p.bytes != null) { bytes = p.bytes; type = p.mime; file = Wire.renamed(name, p.mime).takeIf { p.mime != mime } ?: name } }
        }
        if (bytes == null) {
            Wire.tooLarge(name, size, max).let { if (it.isNotEmpty()) return Prepared(null, mime, name, thumb, it) }
            bytes = try { withContext(Dispatchers.IO) { read(ctx, uri, max) } } catch (e: IOException) {
                return Prepared(null, mime, name, thumb, "$name: ${e.message ?: "it could not be read"}")
            }
        }
        Wire.tooLarge(file, bytes.size.toLong(), max).let { if (it.isNotEmpty()) return Prepared(null, type, file, thumb, it) }
        return Prepared(bytes, type, file, thumb)
    }

    private fun meta(ctx: Context, uri: Uri): Pair<String, Long?> = runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (!c.moveToFirst()) null
            else {
                val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { c.getString(it) }
                val s = c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { c.getLong(it) }
                (n ?: "") to s
            }
        }
    }.getOrNull().let { (it?.first?.ifBlank { null } ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file") to it?.second }

    // When a photo was taken, in ms since the epoch: the photo picker and the media store say it in
    // DATE_TAKEN; a photo with no date of its own (a screenshot, a saved image) has its file's date,
    // else the moment it was picked. Each column is asked on its own, so a provider that refuses one
    // still gives the others.
    private fun taken(ctx: Context, uri: Uri): Long =
        column(ctx, uri, MediaStore.MediaColumns.DATE_TAKEN)
            ?: column(ctx, uri, MediaStore.MediaColumns.DATE_MODIFIED)?.let { it * 1000 }
            ?: System.currentTimeMillis()
    private fun column(ctx: Context, uri: Uri, name: String): Long? = runCatching {
        ctx.contentResolver.query(uri, arrayOf(name), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0).takeIf { it > 0 } else null
        }
    }.getOrNull()

    // The file's bytes; past `max` it is refused, without reading the rest.
    private fun read(ctx: Context, uri: Uri, max: Long?): ByteArray {
        val input = ctx.contentResolver.openInputStream(uri) ?: throw IOException("the file could not be opened")
        return input.use { s ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val n = s.read(buf); if (n < 0) break
                total += n
                if (max != null && max > 0 && total > max) throw IOException("it is over ${Wire.mb(max)}, the most the computer takes a file")
                out.write(buf, 0, n)
            }
            out.toByteArray()
        }
    }

    /** bytes: the photo written again, or null when it goes as picked. */
    private class Ready(val bytes: ByteArray?, val mime: String, val thumb: ImageBitmap?)

    // A photo as it goes up: as picked, or scaled to the daemon's edge and written as PNG or JPEG
    // (Wire.photoPlan), which also leaves out where it was taken (a written copy carries no EXIF).
    // The decoder turns it upright by its EXIF orientation, so the copy needs none.
    private fun photo(ctx: Context, uri: Uri, mime: String, me: Me): Ready {
        var w = 0; var h = 0
        val source = { ImageDecoder.createSource(ctx.contentResolver, uri) }
        val thumb = ImageDecoder.decodeBitmap(source()) { d, info, _ ->
            w = info.size.width; h = info.size.height
            d.setTargetSampleSize(sample(maxOf(w, h), THUMB))
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }.asImageBitmap()
        val plan = Wire.photoPlan(mime, w, h, me.imageEdge, me.readable, located = located(ctx, uri, mime)) ?: return Ready(null, mime, thumb)
        val edge = maxOf(plan.width, plan.height)
        val big = ImageDecoder.decodeBitmap(source()) { d, _, _ ->
            d.setTargetSampleSize(sample(maxOf(w, h), edge))
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        // Scaled by the decoded bitmap's own sides: upright already, whatever the file's were.
        val f = minOf(1.0, edge.toDouble() / maxOf(big.width, big.height))
        val fit = if (f < 1.0) big.scale(maxOf(1, Math.round(big.width * f).toInt()), maxOf(1, Math.round(big.height * f).toInt())) else big
        val out = ByteArrayOutputStream()
        // JPEG at 88, as the workbench writes a scaled picture.
        if (plan.mime == "image/png") fit.compress(Bitmap.CompressFormat.PNG, 100, out) else fit.compress(Bitmap.CompressFormat.JPEG, 88, out)
        if (fit !== big) big.recycle()
        fit.recycle()
        return Ready(out.toByteArray(), plan.mime, thumb)
    }

    // Whether a JPEG or WebP says where it was taken (the Files picker keeps it; the photo picker may too).
    private fun located(ctx: Context, uri: Uri, mime: String): Boolean =
        (mime == "image/jpeg" || mime == "image/webp") && runCatching {
            ctx.contentResolver.openInputStream(uri)?.use { FloatArray(2).let { ll -> ExifInterface(it).getLatLong(ll) } } ?: false
        }.getOrDefault(true) // Not readable: written again, to be sure.

    /** The thumbnail's long edge, in pixels: a chip is 64 dp, three pixels a dp at most. */
    const val THUMB = 192

    /** The largest power of two that keeps the long edge at `want` pixels or more. */
    fun sample(long: Int, want: Int): Int { var s = 1; while (long / (s * 2) >= want) s *= 2; return s }
}

/** Images of the transcript, read from the daemon once (GET /v1/media/<id>) and kept while the app runs. */
object Media {
    // An eighth of the app's memory, the share Android's guide to caching bitmaps gives a cache like this.
    private val cache = object : LruCache<String, ImageBitmap>((Runtime.getRuntime().maxMemory() / 8).toInt()) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }
    fun clear() = cache.evictAll()
    fun cached(id: String, edge: Int): ImageBitmap? = cache.get("$id@$edge")

    /** The image with the id, decoded with its long edge at `edge` pixels or a little more. */
    suspend fun get(id: String, edge: Int): ImageBitmap {
        cached(id, edge)?.let { return it }
        val bytes = Api.bytes("/v1/media/${Uri.encode(id)}")
        val bmp = withContext(Dispatchers.Default) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { d, info, _ ->
                d.setTargetSampleSize(Attach.sample(maxOf(info.size.width, info.size.height), edge))
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }.asImageBitmap()
        }
        cache.put("$id@$edge", bmp)
        return bmp
    }
}
