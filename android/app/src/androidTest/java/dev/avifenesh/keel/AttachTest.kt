package dev.avifenesh.keel

import android.graphics.Bitmap
import android.graphics.Color
import android.media.ExifInterface
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.FileOutputStream

// A photo goes up without where it was taken, whatever its size; a file goes as it is, read no
// further than the daemon's limit.
class AttachTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val me = Me("fx:m", "phone", maxBytes = 20L * 1024 * 1024, imageEdge = 2000, inlineImages = Me.DEFAULT_INLINE)

    private fun photo(name: String, w: Int, h: Int, gps: Boolean): Uri {
        val f = File(ctx.cacheDir, name)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(20, 120, 200)) }
        FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        if (gps) ExifInterface(f.path).apply {
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "48/1,51/1,2952/100"); setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "2/1,17/1,4020/100"); setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
            setAttribute(ExifInterface.TAG_ORIENTATION, "1"); saveAttributes()
        }
        return Uri.fromFile(f)
    }
    private fun located(b: ByteArray) = ExifInterface(b.inputStream()).getLatLong(FloatArray(2))

    @Test fun aPhotoWithinTheEdgeThatSaysWhereItWasTakenGoesUpWithoutIt() = runBlocking {
        val uri = photo("located.jpg", 1200, 900, gps = true)
        assertTrue("the test photo says where it was taken", located(File(uri.path!!).readBytes()))
        val p = Attach.prepare(ctx, uri, "located.jpg", "image/jpeg", File(uri.path!!).length(), me)
        assertEquals("", p.refused)
        assertNotNull(p.bytes)
        assertFalse("the place went up with the photo", located(p.bytes!!))
        assertEquals("image/jpeg", p.mime)
    }

    @Test fun aPhotoThatSaysNothingOfItGoesAsPicked() = runBlocking {
        val uri = photo("plain.jpg", 1200, 900, gps = false)
        val p = Attach.prepare(ctx, uri, "plain.jpg", "image/jpeg", File(uri.path!!).length(), me)
        assertTrue(File(uri.path!!).readBytes().contentEquals(p.bytes))
    }

    @Test fun aFileOverTheLimitIsRefusedBeforeItIsRead() = runBlocking {
        val f = File(ctx.cacheDir, "big.bin").apply { writeBytes(ByteArray(64 * 1024)) }
        // Its size unknown (a provider that does not say it): read no further than the limit.
        val p = Attach.prepare(ctx, Uri.fromFile(f), "big.bin", "application/octet-stream", null, me.copy(maxBytes = 16 * 1024))
        assertEquals(null, p.bytes)
    }
}
