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
import androidx.activity.compose.setContent
import androidx.fragment.app.FragmentActivity
import dev.avifenesh.keel.ui.ConfirmSheet
import dev.avifenesh.keel.ui.KeelTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

object Approvals {
    /** done(null): applied; done(""): the owner cancelled the prompt; done(text): what went wrong. */
    /**
     * seen: the whole text of the request was on screen before this answer. via: "notification" from a
     * notification's action. rule: what a standing answer stores, named in the prompt.
     * The prompt carries no text of the request: a prompt's subtitle is cut, and a cut request is not
     * what is allowed. The request stands whole on the screen under it.
     */
    fun run(act: FragmentActivity, aid: String, choice: String, answers: Map<String, Any>?, seen: Boolean = false, via: String? = null, rule: String = "", feedback: String? = null, heading: String? = null, fresh: Boolean = false, done: (String?) -> Unit) {
        val body = Wire.answerBody(choice, answers, seen, via, feedback, fresh)
        fun submit(headers: Map<String, String>) {
            Hub.scope.launch {
                val r = runCatching { Hub.resolve(aid, body, headers) }
                withContext(Dispatchers.Main) {
                    val card = r.getOrNull()
                    when {
                        r.isFailure -> done(r.exceptionOrNull()?.message ?: "Not sent")
                        card?.state == "expired" -> done("That card had already closed")
                        else -> {
                            Notify.cancelCard(act, aid); done(null)
                            // A plan that went to a fresh session: the work goes on there, so that is where the owner follows it.
                            card?.freshChat?.takeIf { fresh && it.isNotBlank() }?.let { Ui.open(it) }
                        }
                    }
                }
            }
        }
        if (choice == "deny") return submit(emptyMap())
        val ts = (System.currentTimeMillis() / 1000).toString()
        val payload = Wire.approvalMessage(aid, choice, ts, if (fresh) Wire.FRESH else if (answers != null) Wire.answersText(answers) else "").toByteArray()
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
            heading != null -> heading
            answers != null -> "Send the answer"
            choice == "session" -> "Allow for this session"
            choice == "always" -> "Always allow"
            else -> "Allow once"
        }
        val info = BiometricPrompt.PromptInfo.Builder().setTitle(title).setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        if (rule.isNotBlank() && (choice == "session" || choice == "always")) info.setDescription("The rule: $rule")
        prompt.authenticate(info.build(), BiometricPrompt.CryptoObject(sig))
    }
}

object Landings {
    /**
     * Lands a branch from its card: the approval key signs the card's key and the print of what it showed, after a
     * biometric or device-credential check (as an approval is). done(outcome, null): the daemon answered (queued, or
     * refused with the card as it is now); done(null, ""): the owner cancelled; done(null, text): what went wrong.
     */
    fun run(act: FragmentActivity, card: LandCard, done: (LandOutcome?, String?) -> Unit) {
        val ts = (System.currentTimeMillis() / 1000).toString()
        val payload = Wire.landMessage(card.key, card.fp, ts).toByteArray()
        fun submit(sig: String) {
            Hub.scope.launch {
                val r = runCatching { Hub.land(card, mapOf("X-HM-Ts" to ts, "X-HM-ASig" to sig)) }
                withContext(Dispatchers.Main) { done(r.getOrNull(), r.exceptionOrNull()?.let { it.message ?: "Not sent" }) }
            }
        }
        val sig = try { Keys.approvalSignature() } catch (e: Exception) { return done(null, "The approval key is not available: ${e.message}") }
        if (Prefs.noLock) {
            val s = runCatching { sig.update(payload); Base64.encodeToString(sig.sign(), Base64.NO_WRAP) }.getOrNull()
            return if (s == null) done(null, "Signing failed") else submit(s)
        }
        val prompt = BiometricPrompt(act, ContextCompat.getMainExecutor(act), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val s = result.cryptoObject?.signature ?: return done(null, "No signature")
                val out = try { s.update(payload); Base64.encodeToString(s.sign(), Base64.NO_WRAP) } catch (e: Exception) { return done(null, e.message ?: "Signing failed") }
                submit(out)
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED || errorCode == BiometricPrompt.ERROR_CANCELED || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                done(null, if (cancelled) "" else errString.toString())
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder().setTitle("Land ${card.branch}").setDescription("Onto ${card.base.ifBlank { "the base" }} at ${card.short}, through the landing queue")
            .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        prompt.authenticate(info.build(), BiometricPrompt.CryptoObject(sig))
    }
}

/**
 * Allow from a notification. A collapsed notification shows the start of its line, so the request
 * is drawn whole here first, over the lock screen, with its session's name: the fingerprint is asked
 * for under text that is all on screen, never under a cut line. The daemon offers this only for a
 * request whose whole line fits a collapsed notification, and refuses it for any other, with the reason.
 */
class ApproveActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true); setTurnScreenOn(true)
        val aid = intent.getStringExtra("aid") ?: return finish()
        val choice = intent.getStringExtra("choice") ?: "once"
        val title = intent.getStringExtra("title").orEmpty()
        val body = intent.getStringExtra("summary").orEmpty()
        setContent {
            KeelTheme(Prefs.theme) {
                ConfirmSheet(title, body, onAllow = {
                    Approvals.run(this, aid, choice, null, via = "notification") { err ->
                        when {
                            err == null -> Toast.makeText(this, "Allowed", Toast.LENGTH_SHORT).show()
                            err.isNotEmpty() -> Toast.makeText(this, err, Toast.LENGTH_LONG).show()
                        }
                        // (A cancelled prompt leaves the sheet up: the owner may read again, or close it.)
                        if (err == null || err.isNotEmpty()) finish()
                    }
                }, onClose = { finish() })
            }
        }
    }
}
