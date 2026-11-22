// Answering a card: the approval key signs the exact decision after a
// biometric or device-credential check; a deny or a dismiss needs no signature.
package dev.avifenesh.keel

import android.os.Bundle
import android.util.Base64
import android.widget.Toast
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

object Approvals {
    /** done(null): applied; done(""): the owner cancelled the prompt; done(text): what went wrong. */
    /** seen: the whole text of the request was on screen before this answer. via: "notification" from a notification's action. */
    fun run(act: FragmentActivity, aid: String, choice: String, summary: String, answers: Map<String, Any>?, seen: Boolean = false, via: String? = null, done: (String?) -> Unit) {
        val body = Wire.answerBody(choice, answers, seen, via)
        fun submit(headers: Map<String, String>) {
            Hub.scope.launch {
                val r = runCatching { Hub.resolve(aid, body, headers) }
                withContext(Dispatchers.Main) {
                    val card = r.getOrNull()
                    when {
                        r.isFailure -> done(r.exceptionOrNull()?.message ?: "Not sent")
                        card?.state == "expired" -> done("That card had already closed")
                        else -> { Notify.cancelCard(act, aid); done(null) }
                    }
                }
            }
        }
        if (choice == "deny") return submit(emptyMap())
        val ts = (System.currentTimeMillis() / 1000).toString()
        val payload = Wire.approvalMessage(aid, choice, ts, if (answers != null) Wire.answersText(answers) else "").toByteArray()
        fun headers(sig: String) = mapOf("X-HM-Ts" to ts, "X-HM-ASig" to sig, "X-HM-ASig-V" to "2")
        val sig = try { Keys.approvalSignature() } catch (e: Exception) { return done("The approval key is not available: ${e.message}") }
        if (Prefs.noLock) {
            val s = runCatching { sig.update(payload); Base64.encodeToString(sig.sign(), Base64.NO_WRAP) }.getOrNull()
            return if (s == null) done("Signing failed") else submit(headers(s))
        }
        val prompt = BiometricPrompt(act, ContextCompat.getMainExecutor(act), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val s = result.cryptoObject?.signature ?: return done("No signature")
                val out = try { s.update(payload); Base64.encodeToString(s.sign(), Base64.NO_WRAP) } catch (e: Exception) { return done(e.message ?: "Signing failed") }
                submit(headers(out))
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED || errorCode == BiometricPrompt.ERROR_CANCELED || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                done(if (cancelled) "" else errString.toString())
            }
        })
        val title = when {
            answers != null -> "Send the answer"
            choice == "session" -> "Allow for this session"
            else -> "Allow once"
        }
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle(summary.take(140))
                .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL).build(),
            BiometricPrompt.CryptoObject(sig),
        )
    }
}

/**
 * Allow from a notification: the prompt over the lock screen, then gone. The notification offers it
 * only for a request its one line shows whole; the daemon refuses it for any other, with the reason.
 */
class ApproveActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true); setTurnScreenOn(true)
        val aid = intent.getStringExtra("aid") ?: return finish()
        Approvals.run(this, aid, intent.getStringExtra("choice") ?: "once", intent.getStringExtra("summary").orEmpty(), null, via = "notification") { err ->
            when {
                err == null -> Toast.makeText(this, "Allowed", Toast.LENGTH_SHORT).show()
                err.isNotEmpty() -> Toast.makeText(this, err, Toast.LENGTH_LONG).show()
            }
            finish()
        }
    }
}
