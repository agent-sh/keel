// The connection to the daemon: encrypted preferences, the two Keystore keys,
// the signed HTTP client and pairing. Adapted from the Hermes for Android app
// (MIT, same author); see android/NOTICE. The wire is keel-bun's /v1 surface.
package dev.avifenesh.keel

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import org.json.JSONObject
import java.io.IOException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Preferences; the bearer token is sealed with a non-exportable Keystore AES key. */
object Prefs {
    private lateinit var sp: SharedPreferences
    fun init(c: Context) { sp = c.getSharedPreferences("keel", Context.MODE_PRIVATE) }
    private fun g(k: String): String? = sp.getString(k, null)
    private fun s(k: String, v: String?) { sp.edit().apply { if (v == null) remove(k) else putString(k, v) }.apply() }
    var base: String? get() = g("base"); set(v) = s("base", v)
    var token: String? get() = sec("token"); set(v) = setSec("token", v)
    var deviceId: String? get() = g("device"); set(v) = s("device", v)
    var server: String? get() = g("server"); set(v) = s("server", v)
    var fcmToken: String? get() = g("fcmtok"); set(v) = s("fcmtok", v)
    var pushState: String? get() = g("push"); set(v) = s("push", v)
    var notified: String? get() = g("notified"); set(v) = s("notified", v)
    var theme: Int get() = sp.getInt("theme", 0); set(v) { sp.edit().putInt("theme", v).apply() }
    var noLock: Boolean get() = sp.getBoolean("nolock", false); set(v) { sp.edit().putBoolean("nolock", v).apply() }
    /** The owner swiped the lasting notification away; cleared when the work it told of is over. */
    var liveSwiped: Boolean get() = sp.getBoolean("liveswiped", false); set(v) { sp.edit().putBoolean("liveswiped", v).apply() }
    val paired: Boolean get() = token != null && base != null
    fun clear() { val t = theme; sp.edit().clear().apply(); theme = t }

    private const val SEC_KEY = "keel_prefs"
    private fun aes(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(SEC_KEY, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(KeyGenParameterSpec.Builder(SEC_KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return g.generateKey()
    }
    /** Bytes sealed with the same non-exportable key as the token: the IV, then the AES-GCM ciphertext. */
    @Synchronized fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, aes()) }
        return c.iv + c.doFinal(plain)
    }
    /** What `seal` sealed, or null when it cannot be opened (another key, damaged bytes). */
    @Synchronized fun unseal(b: ByteArray): ByteArray? = runCatching {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, aes(), GCMParameterSpec(128, b, 0, 12))
        c.doFinal(b, 12, b.size - 12)
    }.getOrNull()
    /** When the phone was last level with the computer (ms), kept with the last sync. */
    var levelAt: Long get() = sp.getLong("level_at", 0L); set(v) { sp.edit().putLong("level_at", v).apply() }
    @Synchronized private fun setSec(k: String, v: String?) {
        val sealed = v?.let {
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, aes()) }
            Base64.encodeToString(c.iv + c.doFinal(it.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        }
        sp.edit().apply { if (sealed == null) remove("e_$k") else putString("e_$k", sealed) }.apply()
    }
    @Synchronized private fun sec(k: String): String? = g("e_$k")?.let { e ->
        runCatching {
            val b = Base64.decode(e, Base64.NO_WRAP)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, aes(), GCMParameterSpec(128, b, 0, 12))
            String(c.doFinal(b, 12, b.size - 12), Charsets.UTF_8)
        }.getOrNull()
    }
}

/** Two hardware-backed P-256 keys: REQ signs every request; APR signs approvals and needs a biometric or PIN per use. */
object Keys {
    const val REQ = "keel_req"
    const val APR = "keel_apr"
    private fun ks(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun reset() { val k = ks(); listOf(REQ, APR).forEach { if (k.containsAlias(it)) k.deleteEntry(it) } }

    fun ensure() {
        val k = ks()
        if (!k.containsAlias(REQ)) gen(REQ, false)
        if (!k.containsAlias(APR)) {
            // No screen lock: the key cannot require one, and the daemon allows approving once only.
            try { gen(APR, true); Prefs.noLock = false } catch (e: Exception) { gen(APR, false); Prefs.noLock = true }
        }
    }

    private fun gen(alias: String, auth: Boolean) {
        fun spec(strong: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply {
                if (auth) {
                    setUserAuthenticationRequired(true)
                    setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                    setInvalidatedByBiometricEnrollment(false)
                }
                if (strong) setIsStrongBoxBacked(true)
            }.build()
        val g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try { g.initialize(spec(auth)); g.generateKeyPair() } catch (e: Exception) {
            if (!auth) throw e
            g.initialize(spec(false)); g.generateKeyPair()
        }
    }

    fun pub(alias: String): String = Base64.encodeToString(ks().getCertificate(alias).publicKey.encoded, Base64.NO_WRAP)

    fun sign(data: ByteArray): String = Signature.getInstance("SHA256withECDSA").run {
        initSign(ks().getKey(REQ, null) as PrivateKey); update(data); Base64.encodeToString(sign(), Base64.NO_WRAP)
    }

    fun approvalSignature(): Signature = Signature.getInstance("SHA256withECDSA").apply { initSign(ks().getKey(APR, null) as PrivateKey) }
}

/** `body`: what the daemon answered, for a refusal that carries more than its words (a landing card as it is now). */
class ApiError(val code: Int, msg: String, val body: String = "") : Exception(msg)

/** Keep cancellation attached until the body is read. */
internal suspend fun <T> Call.awaitBody(read: (Response) -> T): T = suspendCancellableCoroutine { k ->
    k.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (k.isActive) k.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) {
            try { k.resume(response.use { read(it) }) } catch (e: Exception) { if (k.isActive) k.resumeWithException(e) }
        }
    })
}

private fun bodyHash(body: RequestBody?): String {
    if (body == null) return Wire.sha256Hex(ByteArray(0))
    val b = Buffer(); body.writeTo(b)
    return Wire.sha256Hex(b.readByteArray())
}

object Api {
    private val JSON = "application/json".toMediaType()
    /** Bumped on unpair: a response of the old pairing is dropped. */
    @Volatile var generation = 0L

    private val signer = Interceptor { chain ->
        val r = chain.request()
        val tok = Prefs.token ?: throw IOException("Not paired")
        val ts = r.header("X-HM-Ts") ?: (System.currentTimeMillis() / 1000).toString()
        val canon = Wire.canonical(r.method, r.url.encodedPath, r.url.encodedQuery, ts, bodyHash(r.body))
        chain.proceed(r.newBuilder().header("Authorization", "Bearer $tok").header("X-HM-Ts", ts)
            .header("X-HM-Sig", try { Keys.sign(canon.toByteArray()) } catch (e: Exception) { throw IOException("Request signing failed", e) }).build())
    }
    // Redirects could carry the signature and token elsewhere: they surface as errors.
    val http: OkHttpClient by lazy {
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).addInterceptor(signer).build()
    }
    val sse: OkHttpClient by lazy { http.newBuilder().readTimeout(45, TimeUnit.SECONDS).build() }
    // An upload as large as the daemon takes (20 MB) needs under three minutes at 1 Mbit/s: the write gets five, not the minute a request of words gets.
    private val slow: OkHttpClient by lazy { http.newBuilder().writeTimeout(5, TimeUnit.MINUTES).readTimeout(2, TimeUnit.MINUTES).build() }
    private val plain: OkHttpClient by lazy {
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    }

    fun request(p: String): Request.Builder = Request.Builder().url((Prefs.base ?: throw ApiError(0, "Not paired")).trimEnd('/') + p)

    private suspend fun exec(req: Request, client: OkHttpClient = http): JSONObject {
        val gen = generation
        val o = client.newCall(req).awaitBody { resp ->
            val t = resp.body.string()
            if (!resp.isSuccessful) {
                val m = errorOf(t)
                throw ApiError(resp.code, m.ifBlank { if (resp.code == 401) "Not authorized (HTTP 401)" else "HTTP ${resp.code}" }, t)
            }
            if (t.isBlank()) JSONObject() else JSONObject(t)
        }
        if (gen != generation) throw IOException("The pairing changed")
        return o
    }

    suspend fun get(p: String): JSONObject = exec(request(p).build())
    suspend fun post(p: String, body: JSONObject = JSONObject(), headers: Map<String, String> = emptyMap()): JSONObject =
        exec(request(p).post(body.toString().toRequestBody(JSON)).apply { headers.forEach { (k, v) -> header(k, v) } }.build())
    suspend fun patch(p: String, body: JSONObject): JSONObject = exec(request(p).patch(body.toString().toRequestBody(JSON)).build())
    suspend fun delete(p: String): JSONObject = exec(request(p).delete().build())
    /** A file's bytes as the body (POST /v1/upload). It may take longer than a request of words: the write waits for the network. */
    suspend fun postBytes(p: String, bytes: ByteArray, mime: String): JSONObject =
        exec(request(p).post(bytes.toRequestBody(mime.ifBlank { "application/octet-stream" }.toMediaType())).build(), slow)
    /** The bytes of a stored file (GET /v1/media/<id>). */
    suspend fun bytes(p: String): ByteArray {
        val gen = generation
        val b = http.newCall(request(p).build()).awaitBody { resp ->
            if (!resp.isSuccessful) throw ApiError(resp.code, errorOf(resp.body.string()).ifBlank { "HTTP ${resp.code}" })
            resp.body.bytes()
        }
        if (gen != generation) throw IOException("The pairing changed")
        return b
    }

    /** Pairs with a link's one-time code. Failure leaves the current pairing as it was. */
    suspend fun pair(link: Wire.PairLink): Unit = withContext(Dispatchers.IO) {
        Keys.ensure()
        val body = JSONObject().put("code", link.code).put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("pub", Keys.pub(Keys.REQ)).put("apub", Keys.pub(Keys.APR)).put("lock", !Prefs.noLock)
        val req = Request.Builder().url(link.base + "/v1/pair").post(body.toString().toRequestBody(JSON)).build()
        val p = Paired.of(exec(req, plain))
        if (p.token.isBlank()) throw ApiError(0, "The daemon sent no token")
        if (p.deviceId.isBlank()) throw ApiError(0, "The daemon sent no device id")
        generation++
        Prefs.base = link.base
        Prefs.deviceId = p.deviceId
        Prefs.server = p.server.ifBlank { link.name }
        Prefs.fcmToken = null; Prefs.pushState = null; Prefs.notified = null
        Prefs.token = p.token
    }
}
