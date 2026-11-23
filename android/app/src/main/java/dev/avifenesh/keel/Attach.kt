// Files for the next message: picked on the phone, each read, a photo made
// fit for the model, and uploaded at once (POST /v1/upload), so Send carries
// only their ids. What is picked stays with its session until it is sent or
// removed, also when the session is left and opened again.
package dev.avifenesh.keel

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import android.util.LruCache
import android.webkit.MimeTypeMap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.scale
import kotlinx.coroutines.CancellationException
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

/** Where a picked file stands: being read and made fit, going up, stored on the computer, or not sent. */
enum class Up { READING, UPLOADING, READY, FAILED }

data class Picked(
    val key: String, val name: String, val mime: String, val size: Long, val state: Up,
    val thumb: ImageBitmap? = null, val upload: Upload? = null, val error: String = "",
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

    fun reset() { pending.value = emptyMap(); limits = null; Media.clear() }

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

    private suspend fun limits(): Me? = limits ?: runCatching { Hub.me() }.getOrNull()?.also { limits = it }

    /** Files the owner picked for a session's next message: each is read and uploaded on its own. */
    fun add(ctx: Context, chat: String, uris: List<Uri>) {
        val app = ctx.applicationContext
        for (uri in uris) {
            val (name, size) = meta(app, uri)
            val mime = app.contentResolver.getType(uri)?.lowercase()
                ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
                ?: "application/octet-stream"
            val key = UUID.randomUUID().toString()
            put(chat, Picked(key, name, mime, size ?: 0, Up.READING))
            Hub.scope.launch { take(app, chat, key, uri, name, mime, size) }
        }
    }

    private suspend fun take(ctx: Context, chat: String, key: String, uri: Uri, name: String, mime: String, size: Long?) {
        try {
            val me = limits()
            // A photo is made smaller before it is checked; any other file is refused before it is read.
            if (!mime.startsWith("image/")) Wire.tooLarge(name, size, me?.maxBytes).let { if (it.isNotEmpty()) return fail(chat, key, it) }
            val raw = withContext(Dispatchers.IO) { read(ctx, uri, if (mime.startsWith("image/")) null else me?.maxBytes) }
            var bytes = raw; var type = mime; var file = name; var thumb: ImageBitmap? = null
            if (mime.startsWith("image/")) decoding.withPermit {
                withContext(Dispatchers.Default) { runCatching { photo(raw, mime, me) }.getOrNull() }
            }?.let { p -> bytes = p.bytes; type = p.mime; file = Wire.renamed(name, p.mime).takeIf { p.mime != mime } ?: name; thumb = p.thumb }
            Wire.tooLarge(file, bytes.size.toLong(), me?.maxBytes).let { if (it.isNotEmpty()) return fail(chat, key, it) }
            change(chat, key) { it.copy(name = file, mime = type, size = bytes.size.toLong(), thumb = thumb, state = Up.UPLOADING) }
            val u = Upload.of(Api.postBytes(Wire.uploadPath(file, type), bytes, type))
            if (u.id.isBlank()) return fail(chat, key, "$file: the computer sent no id for it. Remove it and pick it again.")
            change(chat, key) { it.copy(state = Up.READY, upload = u, mime = u.mime.ifBlank { type }, size = u.size.takeIf { s -> s > 0 } ?: it.size) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            fail(chat, key, "$name: ${e.message ?: e.javaClass.simpleName}")
        }
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

    private class Ready(val bytes: ByteArray, val mime: String, val thumb: ImageBitmap?)

    // A photo as it goes up: as picked, or scaled to the daemon's edge and written as PNG or JPEG
    // (Wire.photoPlan). The decoder turns it upright by its EXIF orientation, so a written copy needs none.
    private fun photo(bytes: ByteArray, mime: String, me: Me?): Ready {
        var w = 0; var h = 0
        val thumb = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { d, info, _ ->
            w = info.size.width; h = info.size.height
            d.setTargetSampleSize(sample(maxOf(w, h), THUMB))
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }.asImageBitmap()
        val plan = Wire.photoPlan(mime, w, h, me?.imageEdge, me?.readable ?: Me.DEFAULT_INLINE) ?: return Ready(bytes, mime, thumb)
        val edge = maxOf(plan.width, plan.height)
        val big = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { d, _, _ ->
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
