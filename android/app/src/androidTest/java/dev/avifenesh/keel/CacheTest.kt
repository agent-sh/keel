package dev.avifenesh.keel

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

// The last sync is kept sealed in the app's own files: read back whole, never readable as text,
// dropped when damaged, and gone with the pairing.
class CacheTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val file = File(ctx.filesDir, "last-sync.bin")

    @Test fun theLastSyncIsKeptSealedAndReadBackWhole() {
        Prefs.init(ctx); Cache.init(ctx)
        val snap = JSONObject().put("seq", 42).put("complete", true).put("chats", org.json.JSONArray().put(JSONObject().put("id", "s-1").put("title", "Rotate the signing key")))
        Cache.save(snap)
        assertFalse("the kept sync reads as text", String(file.readBytes(), Charsets.ISO_8859_1).contains("Rotate the signing key"))
        assertEquals(snap.toString(), Cache.load().toString())
        // Damaged: not read, and not kept.
        file.writeBytes(file.readBytes().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() })
        assertNull(Cache.load())
        assertFalse(file.exists())
        Cache.save(snap)
        Cache.clear()
        assertNull(Cache.load())
    }
}
