// The last sync, kept on the phone so a cold start without the network shows what the phone last
// held. In the app's private files (excluded from backup and device transfer by
// data_extraction_rules.xml), sealed with the Keystore key that seals the token, written whole or
// not at all. Deleted with the pairing.
package dev.avifenesh.keel

import android.content.Context
import org.json.JSONObject
import java.io.File

object Cache {
    private lateinit var dir: File
    private const val NAME = "last-sync.bin"
    fun init(c: Context) { dir = c.filesDir }
    private val file get() = File(dir, NAME)

    @Synchronized fun save(snapshot: JSONObject) {
        val sealed = Prefs.seal(snapshot.toString().toByteArray(Charsets.UTF_8))
        val part = File(dir, "$NAME.part")
        part.writeBytes(sealed)
        if (!part.renameTo(file)) { part.delete(); throw java.io.IOException("the last sync could not be kept") }
    }

    /** The kept snapshot, or null: none kept, or it cannot be opened (it is then removed). */
    @Synchronized fun load(): JSONObject? {
        val f = file
        if (!f.isFile) return null
        val plain = Prefs.unseal(f.readBytes())
        val o = plain?.let { runCatching { JSONObject(String(it, Charsets.UTF_8)) }.getOrNull() }
        if (o == null) f.delete()
        return o
    }

    @Synchronized fun clear() { file.delete(); File(dir, "$NAME.part").delete() }
}
