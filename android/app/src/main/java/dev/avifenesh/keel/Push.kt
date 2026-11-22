// Alerts on the phone: Firebase data pushes when the daemon has push set up for
// this app, else a check every 15 minutes. A push carries ids and a line of
// text, never the conversation; each one is confirmed back to the daemon.
package dev.avifenesh.keel

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object Notify {
    const val NEEDS = "needs"
    const val UPDATES = "updates"

    fun channels(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(NEEDS, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Approvals, questions and failed turns"
        })
        nm.createNotificationChannel(NotificationChannel(UPDATES, "Finished work", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A session finished its turn"
        })
    }

    private fun idOf(key: String) = key.hashCode()

    private fun open(c: Context, chat: String?): PendingIntent = PendingIntent.getActivity(
        c, (chat ?: "main").hashCode(),
        Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP).apply { if (chat != null) putExtra("chat", chat) },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /**
     * One alert. A permission card gets Allow (biometric, over the lock screen)
     * and Deny; a question opens its session. A notification shows one line, so
     * Allow sits on it only for a request that line shows whole: a held one
     * (long, cut, marked, high risk) gets Open and Deny, and is read in the app.
     */
    fun post(c: Context, kind: String, chat: String?, title: String, body: String, aid: String?, allow: Boolean) {
        val high = kind in setOf("approval", "question", "failed", "loop_failed", "limit", "test")
        val b = NotificationCompat.Builder(c, if (high) NEEDS else UPDATES)
            .setSmallIcon(R.drawable.ic_stat).setColor(0xFF0E6A80.toInt())
            .setContentTitle(title.ifBlank { "Keel" }).setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open(c, chat)).setAutoCancel(true)
            .setCategory(if (kind == "approval") NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (high) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
        if (aid != null && !aid.startsWith("q-") && kind == "approval") {
            if (!allow) b.addAction(0, "Open", open(c, chat))
            else b.addAction(0, "Allow once", PendingIntent.getActivity(c, idOf("$aid/once"),
                Intent(c, ApproveActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("aid", aid).putExtra("choice", "once").putExtra("summary", body).putExtra("title", title),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            b.addAction(0, "Deny", PendingIntent.getBroadcast(c, idOf("$aid/deny"),
                Intent(c, NotifyReceiver::class.java).setAction(NotifyReceiver.DENY).putExtra("aid", aid),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        runCatching { c.getSystemService(NotificationManager::class.java).notify(chat ?: "keel", idOf(aid ?: "$kind/$chat"), b.build()) }
    }

    fun cancelCard(c: Context, aid: String) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.activeNotifications.filter { it.id == idOf(aid) }.forEach { nm.cancel(it.tag, it.id) }
    }

    /** Everything shown for a session, once nothing in it waits any more. */
    fun cancelChat(c: Context, chat: String) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.activeNotifications.filter { it.tag == chat }.forEach { nm.cancel(it.tag, it.id) }
    }
}

/** Deny from the notification: no signature is needed to refuse. */
class NotifyReceiver : BroadcastReceiver() {
    companion object { const val DENY = "dev.avifenesh.keel.DENY" }
    override fun onReceive(c: Context, i: Intent) {
        if (i.action != DENY) return
        val aid = i.getStringExtra("aid") ?: return
        val done = goAsync()
        Hub.scope.launch {
            val r = runCatching { Hub.resolve(aid, Wire.answerBody("deny", null, via = "notification"), emptyMap()) }
            withContext(Dispatchers.Main) {
                Notify.cancelCard(c, aid)
                Toast.makeText(c, if (r.isSuccess) "Denied" else "Not sent: ${r.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
            }
            done.finish()
        }
    }
}

class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (!Prefs.paired) return
        val m = PushMsg.of(message.data)
        when (m.kind) {
            "withdraw" -> m.chat?.let { Notify.cancelChat(this, it) }
            "live" -> {}
            else -> Notify.post(this, m.kind, m.chat, m.title, m.body, m.card, m.allows)
        }
        m.id?.let { id -> Hub.scope.launch { runCatching { Api.post("/v1/push/ack", JSONObject().put("id", id)) } } }
    }

    override fun onNewToken(token: String) { if (Prefs.paired) Hub.scope.launch { runCatching { Push.refresh(applicationContext) } } }
}

object Push {
    /** What the settings screen says about alerts. */
    val state = MutableStateFlow(Prefs.pushStateOrNull())

    private fun Prefs.pushStateOrNull() = runCatching { pushState }.getOrNull()

    fun available(c: Context): Boolean = runCatching {
        GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(c) == ConnectionResult.SUCCESS
    }.getOrDefault(false)

    private fun set(v: String) { Prefs.pushState = v; state.value = v }

    /** Registers with this app's own Firebase entry on the daemon, or says why not. */
    suspend fun refresh(c: Context): Boolean {
        if (!Prefs.paired) return false
        if (!available(c)) { set("off:This phone has no Google Play services. Keel checks for what needs you every 15 minutes."); return false }
        val cfg = PushConfig.of(Api.get("/v1/push-config?app=${c.packageName}"))
        if (!cfg.enabled) {
            set("off:Push is not set up on the daemon for this app${if (cfg.missing.isNotBlank()) " (it looks for ${cfg.missing})" else ""}. Keel checks for what needs you every 15 minutes.")
            return false
        }
        val options = FirebaseOptions.Builder().setApiKey(cfg.apiKey).setApplicationId(cfg.appId)
            .setProjectId(cfg.projectId).setGcmSenderId(cfg.senderId).build()
        val app = FirebaseApp.getApps(c).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME } ?: FirebaseApp.initializeApp(c, options)
        if (app.options != options) { set("off:The daemon's push project changed. Restart Keel to use it."); return false }
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        val token = withTimeoutOrNull(15_000) {
            suspendCancellableCoroutine<String?> { k ->
                FirebaseMessaging.getInstance().token.addOnCompleteListener { t -> if (k.isActive) k.resumeWith(Result.success(if (t.isSuccessful) t.result else null)) }
            }
        }
        if (token == null) { set("off:Firebase gave no push token. Keel checks for what needs you every 15 minutes."); return false }
        Api.post("/v1/fcm", JSONObject().put("token", token))
        Prefs.fcmToken = token
        set("on")
        return true
    }

    /** Without push: a check every 15 minutes (the shortest Android allows). */
    fun schedule(c: Context) {
        WorkManager.getInstance(c).enqueueUniquePeriodicWork("keel-check", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    fun unschedule(c: Context) { WorkManager.getInstance(c).cancelUniqueWork("keel-check") }
}

/** Notifies each open card once, when push is off. */
class CheckWorker(c: Context, p: WorkerParameters) : CoroutineWorker(c, p) {
    override suspend fun doWork(): Result {
        if (!Prefs.paired || Prefs.pushState == "on") return Result.success()
        val pulse = runCatching { Hub.pulse() }.getOrElse { return Result.retry() }
        val seen = Prefs.notified.orEmpty().split('\n').filter { it.isNotBlank() }.toMutableSet()
        val open = pulse.cards.filter { it.pending }
        val titles = pulse.sessions.associate { it.id to it.title }
        for (card in open) if (card.id !in seen) {
            val title = titles[card.chatId]?.takeIf { it.isNotBlank() } ?: "A session"
            Notify.post(applicationContext, "approval", card.chatId, if (card.question) "$title asks" else "$title needs your approval",
                card.noteLine, card.id, card.glanceable)
            seen += card.id
        }
        // Keep only what is still open, so the list stays small.
        Prefs.notified = seen.filter { id -> open.any { it.id == id } }.joinToString("\n")
        return Result.success()
    }
}
