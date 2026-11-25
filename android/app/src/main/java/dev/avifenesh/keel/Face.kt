// The helper's name and picture on the phone. The owner names the helper and gives it a face on the computer; the daemon
// says the name and a mark of the picture (`name`, `face` of GET /v1/helper, `who` and `face` of a push), and the bytes are
// fetched once per mark (GET /v1/helper/face) and kept in the app's cache folder, which the system may empty and which a
// backup never takes. A new mark replaces the kept picture; unpairing removes it.
package dev.avifenesh.keel

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

object Face {
    /** What the daemon last said of the helper: its name and the picture, once fetched. */
    val name = MutableStateFlow("")
    val picture = MutableStateFlow<Bitmap?>(null)

    /** The picture is kept at this many pixels on its long side at most: a list row and a notification's large icon are small. */
    const val EDGE = 256

    /** A mark as a file name: the daemon's marks are base 36, anything else is not one. */
    fun markOf(v: String): String? = v.takeIf { it.isNotEmpty() && it.length <= 40 && it.all { c -> c in '0'..'9' || c in 'a'..'z' || c in 'A'..'Z' } }

    /** The power of two to decode a picture of `w` by `h` at, so its long side stays at or above EDGE where it can. */
    fun sampleOf(w: Int, h: Int, edge: Int = EDGE): Int {
        var s = 1
        while (maxOf(w, h) / (s * 2) >= edge) s *= 2
        return s
    }

    private fun dir(c: Context) = File(c.cacheDir, "helper-face")

    /** The kept file of a mark. */
    fun fileOf(c: Context, v: String): File? = markOf(v)?.let { File(dir(c), "face-$it") }

    /**
     * The picture of a mark, from the kept file or from the daemon (and then kept, the older ones removed). Null when
     * the daemon has none or cannot be reached: a notification then goes without a face, as it did.
     */
    suspend fun load(c: Context, v: String): Bitmap? {
        val f = fileOf(c, v) ?: return null
        val bytes = if (f.isFile) f.readBytes() else runCatching { Api.bytes("/v1/helper/face") }.getOrNull()?.also { b ->
            dir(c).mkdirs()
            dir(c).listFiles()?.forEach { it.delete() }
            f.writeBytes(b)
        } ?: return null
        return decode(bytes)
    }

    fun decode(bytes: ByteArray): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        if (o.outWidth <= 0 || o.outHeight <= 0) return null
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sampleOf(o.outWidth, o.outHeight) })
    }

    /** A face as a round picture, cut from the middle of the square it fits. */
    fun round(b: Bitmap): Bitmap {
        val side = minOf(b.width, b.height)
        val out = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawOval(RectF(0f, 0f, side.toFloat(), side.toFloat()), paint)
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        canvas.drawBitmap(b, -((b.width - side) / 2f), -((b.height - side) / 2f), paint)
        return out
    }

    /** What GET /v1/helper said: the name now, and the picture when its mark is new here. */
    suspend fun learn(c: Context, name: String, mark: String) {
        this.name.value = name
        if (mark.isBlank()) { picture.value = null; return }
        load(c, mark)?.let { picture.value = round(it) }
    }

    private var home: File? = null
    fun init(c: Context) { home = dir(c) }
    fun clear() { name.value = ""; picture.value = null; runCatching { home?.deleteRecursively() } }
}
