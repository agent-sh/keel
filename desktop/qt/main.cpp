// keel-desktop-qt: the windows of the desktop app, drawn by Qt WebEngine.
//
// This program is an engine and nothing else. The app (../src) finds and
// follows the daemon, keeps the tray mark, shows notifications, takes links
// and decides what every message of the page means. It starts this program
// when the distribution's Qt WebEngine is installed and speaks to it in
// lines of JSON: its commands on standard input, what happened on standard
// output (the list is in ../src/qt.rs). When the app goes away, standard
// input ends and so does this program.
//
// What content inside the web view can reach is listed in ../README.md
// ("What the page can reach"). What is decided here, because the engine asks
// for an answer at once:
//   - the main frame shows places of the page at the daemon's origin and
//     nothing else (pagePath below, the same rule as ../src/links.rs, held to
//     one table by `--self-test`);
//   - no window is opened and no address leaves by itself: both are told to
//     the app, which decides;
//   - every permission request is refused, the engine's clipboard access for
//     script is off, and its own dialogs are not shown.
#include <QApplication>
#include <QBuffer>
#include <QClipboard>
#include <QContextMenuEvent>
#include <QDBusInterface>
#include <QDBusMessage>
#include <QDBusVariant>
#include <QDialog>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QMenu>
#include <QMimeData>
#include <QMouseEvent>
#include <QPainter>
#include <QOffscreenSurface>
#include <QOpenGLContext>
#include <QOpenGLFunctions>
#include <QPointer>
#include <QPushButton>
#include <QSocketNotifier>
#include <QStandardPaths>
#include <QStyleHints>
#include <QThreadPool>
#include <QTimer>
#include <QVBoxLayout>
#include <QVariantAnimation>
#include <QWebChannel>
#include <QWebEngineDownloadRequest>
#include <QWebEngineHistory>
#include <QWebEngineLoadingInfo>
#include <QWebEngineNewWindowRequest>
#include <QWebEnginePage>
#include <QWebEnginePermission>
#include <QWebEngineProfile>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebEngineSettings>
#include <QWebEngineView>
#include <QWindow>
#include <QtWebEngineCore/qtwebenginecoreglobal.h>
#include <QMutex>
#include <QWebEngineUrlRequestInfo>
#include <QWebEngineUrlRequestInterceptor>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <fcntl.h>
#include <memory>
#include <unistd.h>

#ifndef KEEL_VERSION
#define KEEL_VERSION "0"
#endif

// The script heap may grow this far before the engine must collect it (megabytes). Chromium
// inside Qt lets it grow many times further than a browser does before it collects, and the
// process holds all of that; the page's live heap is a small part of this bound, and the bound
// costs no frames. (QTWEBENGINE_CHROMIUM_FLAGS with a --js-flags of the owner's own is left as it is.)
// The engine also gives what it collected back to the system only minutes after the page went
// quiet, where a browser does it in seconds: the page is let to ask for a collection (`gc`),
// which it does when the owner has turned to another window (ui/src/features/shell.ts). Any
// script of the page's process can call it; it collects, and does nothing else.
static const int HEAP_MB = 256;

// A file the page offers is kept when the owner pressed a key or a button in that window this
// long before, at most (the same time ../src/clip.rs gives the other engine).
static const qint64 KEEP_MS = 10000;
// How long the microphone may be given after the page said, at the owner's press, that it is about to ask
// (the same time as MIC in ../src/clip.rs).
static const qint64 MIC_MS = 10000;

// The pipe to the app. It is this program's alone: `main` moves it off descriptor 1 before the
// engine starts, with close-on-exec, so no process the engine starts (a renderer runs the page's
// script) inherits a way to write the app a line. Descriptor 1 is the null device from then on.
static int appPipe = STDOUT_FILENO;
static int appIn = STDIN_FILENO;

static void say(const QJsonObject &m)
{
    static QMutex one;
    const QByteArray line = QJsonDocument(m).toJson(QJsonDocument::Compact) + '\n';
    // (A line whole, also when the thread that reads a picture says one at the same time.)
    const QMutexLocker held(&one);
    for (qsizetype done = 0; done < line.size();) {
        const ssize_t n = ::write(appPipe, line.constData() + done, size_t(line.size() - done));
        if (n < 0 && errno == EINTR)
            continue;
        if (n <= 0)
            return;
        done += n;
    }
}

// Moves a descriptor of the pipes to the app off its standard number, closed on exec, and puts
// the null device in its place.
static int keepPrivate(int fd, int flags)
{
    const int own = ::fcntl(fd, F_DUPFD_CLOEXEC, 3);
    if (own < 0)
        return fd;
    const int null = ::open("/dev/null", flags | O_CLOEXEC);
    if (null >= 0) {
        ::dup2(null, fd);
        ::close(null);
    }
    return own;
}

// ---- The places of the page (the rule of ../src/links.rs) -------------------------------------

static bool isId(QStringView s)
{
    if (s.isEmpty() || s.size() > 80)
        return false;
    for (const QChar c : s) {
        const char16_t u = c.unicode();
        if (!((u >= 'a' && u <= 'z') || (u >= 'A' && u <= 'Z') || (u >= '0' && u <= '9') || u == '-' || u == '_'))
            return false;
    }
    return true;
}

// A path the main frame may show: `/`, `/s/<id>`, `/p/<id>`, `/settings[/<section>]`, `/customize[/<section>]`, with no
// query but the ones the daemon writes for an alert's click.
static bool pagePath(QStringView p)
{
    if (p.size() > 300 || !p.startsWith(u'/'))
        return false;
    const qsizetype q = p.indexOf(u'?');
    const QStringView path = q < 0 ? p : p.left(q);
    const QList<QStringView> parts = path.mid(1).split(u'/');
    bool ok = false;
    if (parts.size() == 1)
        ok = parts[0].isEmpty() || parts[0] == u"settings" || parts[0] == u"customize";
    else if (parts.size() == 2)
        ok = (parts[0] == u"s" || parts[0] == u"p" || parts[0] == u"settings" || parts[0] == u"customize") && isId(parts[1]);
    if (!ok)
        return false;
    if (q < 0)
        return true;
    for (const QStringView pair : p.mid(q + 1).split(u'&')) {
        const qsizetype eq = pair.indexOf(u'=');
        if (eq < 0)
            return false;
        const QStringView k = pair.left(eq), v = pair.mid(eq + 1);
        if (!((k == u"inbox" && v == u"1") || ((k == u"approval" || k == u"e") && isId(v)) || (k == u"panel" && parts[0] == u"s" && isId(v))))
            return false;
    }
    return true;
}

// Whether the main frame may show `uri` while the daemon's page is up.
// Whether a file offered from `uri` is one of the daemon's own: its origin, under its API
// (../src/links.rs `keepable`: not a script's own bytes, not what a session's port serves).
static bool keepable(const QString &uri, const QString &origin)
{
    return !origin.isEmpty() && uri.startsWith(origin + "/api/");
}

static bool mayShow(const QString &uri, const QString &origin)
{
    if (origin.isEmpty() || !uri.startsWith(origin))
        return false;
    QStringView rest = QStringView(uri).mid(origin.size());
    const qsizetype hash = rest.indexOf(u'#');
    return pagePath(hash < 0 ? rest : rest.left(hash));
}

// Where a file is saved in a folder: under its own name, or the next free one.
static QString freeName(const QString &folder, const QString &suggested)
{
    QString name = QFileInfo(suggested).fileName();
    if (name.isEmpty() || name == "." || name == "..")
        name = "download";
    const qsizetype dot = name.lastIndexOf('.');
    const QString stem = dot > 0 ? name.left(dot) : name, ext = dot > 0 ? name.mid(dot) : QString();
    QString pick = name;
    for (int n = 2; QFileInfo::exists(folder + "/" + pick); n++)
        pick = QString("%1 (%2)%3").arg(stem).arg(n).arg(ext);
    return pick;
}

// ---- The look ----------------------------------------------------------------------------------

struct Look {
    bool dark = false;
    QString bg = "#ffffff", panel = "#f6f7f7", fg = "#16191c", muted = "#5b646c", line = "#dfe3e6", need = "#b7791f";
    double scale = 1.0;
    int px(double n) const { return int(std::lround(n * scale)); }
};

static Look lookOf(const QJsonObject &o)
{
    Look l;
    l.dark = o["dark"].toBool();
    const auto color = [&](const char *k, QString &to) {
        const QColor c(o[k].toString());
        if (c.isValid())
            to = c.name();
    };
    color("bg", l.bg);
    color("panel", l.panel);
    color("fg", l.fg);
    color("muted", l.muted);
    color("line", l.line);
    color("need", l.need);
    const double s = o["scale"].toDouble(1.0);
    l.scale = s >= 0.5 && s <= 3.0 ? s : 1.0;
    return l;
}

static QColor faded(const QString &hex, double a)
{
    QColor c(hex);
    c.setAlphaF(float(a));
    return c;
}

static QString rgba(const QString &hex, double a)
{
    const QColor c(hex);
    return QString("rgba(%1,%2,%3,%4)").arg(c.red()).arg(c.green()).arg(c.blue()).arg(a);
}

// ---- What the page says to the app -------------------------------------------------------------

// The one object a page reaches through the engine's channel. It only carries strings to the
// app, which acts on one when it holds the value of that window alone (../src/said.rs).
class Bridge : public QObject {
    Q_OBJECT
public:
    Bridge(int ofWin, bool measured, QObject *parent) : QObject(parent), win(ofWin), probing(measured) {}
    int win; // the window it speaks for (a window kept for the next one asked for is given a new number)
public slots:
    void post(const QString &s) { say({{"t", "said"}, {"win", win}, {"s", s}}); }
    // The reports of the measurer's script, when the app runs with one.
    void probe(const QString &s)
    {
        if (probing)
            say({{"t", "probe"}, {"s", s}});
    }

private:
    bool probing;
};

// Put in the top frame of every document before its own scripts: a function that carries a
// string to the app. The channel's library stays inside this closure.
static QString senderScript()
{
    static QString made;
    if (made.isEmpty()) {
        QFile lib(":/qtwebchannel/qwebchannel.js");
        if (!lib.open(QIODevice::ReadOnly))
            return made;
        made = QString("(() => {\nif (window.top !== window || window.__keelPost) return;\n%1\n"
                       "let app = null; const held = [];\n"
                       "const out = (kind, s) => { if (app) app[kind](s); else held.push([kind, s]); };\n"
                       "Object.defineProperty(window, '__keelPost', { value: (s) => out('post', String(s)) });\n"
                       "Object.defineProperty(window, '__keelProbe', { value: (s) => out('probe', String(s)) });\n"
                       "const join = () => { try { new QWebChannel(qt.webChannelTransport, (ch) => { app = ch.objects.keel; for (const [k, s] of held.splice(0)) app[k](s); }); } catch (e) {} };\n"
                       "if (window.qt && qt.webChannelTransport) join(); else document.addEventListener('DOMContentLoaded', join, { once: true });\n"
                       "})();\n")
                       .arg(QString::fromUtf8(lib.readAll()));
    }
    return made;
}

// ---- The page ----------------------------------------------------------------------------------

class Page : public QWebEnginePage {
    Q_OBJECT
public:
    enum Mode { Nothing, App, Away };
    Mode mode = Nothing;
    // The daemon's origin the page is loaded from; the main frame stays there.
    QString origin;
    // Until when the microphone may be given, once (MIC_MS).
    qint64 micUntil = 0;
    int win;
    bool devtools, probing;

    Page(QWebEngineProfile *profile, int ofWin, bool inspected, bool measured, QObject *parent) : QWebEnginePage(profile, parent), win(ofWin), devtools(inspected), probing(measured) {}

protected:
    // Where a navigation goes. The main frame shows the app's own away page, or a place of the
    // daemon's page: any other document, another origin's or one the daemon serves that is no
    // page, is refused before it is asked for. An address out of Keel is told to the app.
    bool acceptNavigationRequest(const QUrl &url, NavigationType type, bool isMainFrame) override
    {
        if (!isMainFrame)
            return true;
        const QString scheme = url.scheme();
        if (mode == Away)
            return scheme == "data" || scheme == "about";
        if (mode != App)
            return false;
        const QString u = url.toString(QUrl::FullyEncoded);
        if (mayShow(u, origin))
            return true;
        const bool inside = scheme == "about" || scheme == "blob" || scheme == "data" || u == origin || u.startsWith(origin + "/");
        if (!inside && type == NavigationTypeLinkClicked)
            say({{"t", "nav"}, {"win", win}, {"kind", "link"}, {"url", u}});
        return false;
    }

    // The page draws its own dialogs; content inside it must not raise one that reads as the app's.
    void javaScriptAlert(const QUrl &, const QString &) override {}
    bool javaScriptConfirm(const QUrl &, const QString &) override { return false; }
    bool javaScriptPrompt(const QUrl &, const QString &, const QString &, QString *) override { return false; }
    void javaScriptConsoleMessage(JavaScriptConsoleMessageLevel, const QString &message, int line, const QString &source) override
    {
        // A frame the channel does not reach reports to the measurer this way.
        if (probing && message.startsWith("KEELPROBE "))
            say({{"t", "probe"}, {"s", message.mid(10)}});
        if (devtools)
            ::fprintf(stderr, "console: %s (%s:%d)\n", qPrintable(message), qPrintable(source), line);
    }
};

// The web view with a context menu that keeps what acts on the page's content: a browser's
// navigation has no place here.
class View : public QWebEngineView {
public:
    using QWebEngineView::QWebEngineView;
    bool devtools = false;
    QString menuStyle;

protected:
    void contextMenuEvent(QContextMenuEvent *e) override
    {
        std::unique_ptr<QMenu> menu(createStandardContextMenu());
        using A = QWebEnginePage;
        for (const A::WebAction a : {A::Back, A::Forward, A::Reload, A::ReloadAndBypassCache, A::Stop, A::OpenLinkInThisWindow, A::OpenLinkInNewWindow, A::OpenLinkInNewTab,
                                     A::OpenLinkInNewBackgroundTab, A::DownloadLinkToDisk, A::DownloadImageToDisk, A::DownloadMediaToDisk, A::ViewSource, A::SavePage})
            menu->removeAction(page()->action(a));
        if (!devtools)
            menu->removeAction(page()->action(A::InspectElement));
        // No separator first, last or twice.
        bool last = true;
        for (QAction *a : menu->actions()) {
            if (a->isSeparator() && last)
                menu->removeAction(a);
            last = a->isSeparator();
        }
        while (!menu->actions().isEmpty() && menu->actions().constLast()->isSeparator())
            menu->removeAction(menu->actions().constLast());
        if (menu->actions().isEmpty())
            return;
        menu->setAttribute(Qt::WA_DeleteOnClose);
        menu->setStyleSheet(menuStyle);
        menu->popup(e->globalPos());
        (void)menu.release(); // it deletes itself when it closes
    }
};

// ---- The title bar -----------------------------------------------------------------------------

// A control of the window: drawn in the page's ink, as the rest of the bar.
class Control : public QAbstractButton {
public:
    enum Kind { Minimize, Maximize, Restore, Close };
    Kind kind;
    const Look *look;
    Control(Kind what, const Look *colors, QWidget *parent) : QAbstractButton(parent), kind(what), look(colors)
    {
        setFocusPolicy(Qt::NoFocus);
        setCursor(Qt::ArrowCursor);
        setAttribute(Qt::WA_Hover);
        static const char *names[] = {"Minimize", "Maximize", "Restore", "Close"};
        setAccessibleName(names[kind]);
        setToolTip(names[kind]);
    }
    QSize sizeHint() const override { return QSize(look->px(26), look->px(26)); }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const bool over = underMouse(), close = kind == Close;
        if (over || isDown()) {
            p.setPen(Qt::NoPen);
            p.setBrush(close ? QColor("#d9434b") : faded(look->fg, isDown() ? 0.16 : 0.09));
            p.drawRoundedRect(rect(), look->px(7), look->px(7));
        }
        QColor ink = over ? (close ? QColor("#ffffff") : QColor(look->fg)) : QColor(look->muted);
        if (!window()->isActiveWindow() && !over)
            ink.setAlphaF(0.6f);
        p.setPen(QPen(ink, std::max(1.0, 1.25 * look->scale), Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        p.setBrush(Qt::NoBrush);
        const QPointF c = QRectF(rect()).center();
        const double r = 4.5 * look->scale;
        switch (kind) {
        case Minimize:
            p.drawLine(QPointF(c.x() - r, c.y() + r * 0.7), QPointF(c.x() + r, c.y() + r * 0.7));
            break;
        case Maximize:
            p.drawRoundedRect(QRectF(c.x() - r, c.y() - r, 2 * r, 2 * r), 1.5 * look->scale, 1.5 * look->scale);
            break;
        case Restore:
            p.drawRoundedRect(QRectF(c.x() - r, c.y() - r + 2 * look->scale, 2 * r - 2 * look->scale, 2 * r - 2 * look->scale), 1.5 * look->scale, 1.5 * look->scale);
            p.drawPolyline(QPolygonF({QPointF(c.x() - r + 2.5 * look->scale, c.y() - r), QPointF(c.x() + r, c.y() - r), QPointF(c.x() + r, c.y() + r - 2.5 * look->scale)}));
            break;
        case Close:
            p.drawLine(QPointF(c.x() - r, c.y() - r), QPointF(c.x() + r, c.y() + r));
            p.drawLine(QPointF(c.x() + r, c.y() - r), QPointF(c.x() - r, c.y() + r));
            break;
        }
    }
};

// The mark beside the daemon's state while something is under way.
class Dot : public QWidget {
public:
    const Look *look;
    QVariantAnimation pulse;
    Dot(const Look *colors, QWidget *parent) : QWidget(parent), look(colors)
    {
        pulse.setStartValue(0.3);
        pulse.setKeyValueAt(0.5, 1.0);
        pulse.setEndValue(0.3);
        pulse.setDuration(1800);
        pulse.setLoopCount(-1);
        connect(&pulse, &QVariantAnimation::valueChanged, this, [this] { update(); });
    }
    QSize sizeHint() const override { return QSize(look->px(6), look->px(6)); }

protected:
    void showEvent(QShowEvent *) override { pulse.start(); }
    void hideEvent(QHideEvent *) override { pulse.stop(); }
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.setPen(Qt::NoPen);
        p.setBrush(faded(look->need, pulse.currentValue().toDouble()));
        p.drawEllipse(rect());
    }
};

// Which controls the desktop is set to show, and on which side: its own setting, read through
// the settings portal ("appmenu:minimize,maximize,close").
static QString buttonLayout()
{
    // (Read once: the call may wait on the desktop, and every window asks.)
    static QString known;
    if (!known.isEmpty())
        return known;
    known = ":minimize,maximize,close";
    QDBusInterface portal("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Settings");
    portal.setTimeout(400);
    const QDBusMessage r = portal.call("Read", "org.gnome.desktop.wm.preferences", "button-layout");
    if (r.type() == QDBusMessage::ReplyMessage && !r.arguments().isEmpty()) {
        QVariant v = r.arguments().constFirst();
        for (int i = 0; i < 3 && v.canConvert<QDBusVariant>(); i++)
            v = v.value<QDBusVariant>().variant();
        if (v.typeId() == QMetaType::QString && v.toString().contains(':'))
            known = v.toString();
    }
    return known;
}

// The bar the app owns above the page: the app's name, the daemon's state, and the window's
// controls, in the page's colors. It moves the window; a double click maximizes it.
class Bar : public QWidget {
    Q_OBJECT
public:
    const Look *look;
    QLabel *title, *pillText;
    QWidget *pill;
    Dot *dot;
    QPushButton *start;
    QList<Control *> controls;
    Control *maximize = nullptr;

    Bar(const Look *colors, QWidget *parent) : QWidget(parent), look(colors)
    {
        setAttribute(Qt::WA_StyledBackground, false);
        auto *row = new QHBoxLayout(this);
        title = new QLabel("Keel", this);
        title->setAlignment(Qt::AlignCenter);
        title->setAttribute(Qt::WA_TransparentForMouseEvents);
        pill = new QWidget(this);
        pill->setObjectName("pill");
        pill->setAttribute(Qt::WA_StyledBackground);
        auto *in = new QHBoxLayout(pill);
        dot = new Dot(look, pill);
        pillText = new QLabel(pill);
        in->addWidget(dot, 0, Qt::AlignVCenter);
        in->addWidget(pillText);
        pill->hide();
        start = new QPushButton("Start", this);
        start->setObjectName("start");
        start->setCursor(Qt::ArrowCursor);
        start->hide();
        connect(start, &QPushButton::clicked, this, &Bar::startAsked);

        const QStringList sides = buttonLayout().split(':');
        const auto add = [&](const QString &list) {
            for (const QString &name : list.split(',', Qt::SkipEmptyParts)) {
                Control *c = nullptr;
                if (name == "minimize")
                    c = new Control(Control::Minimize, look, this);
                else if (name == "maximize")
                    c = maximize = new Control(Control::Maximize, look, this);
                else if (name == "close")
                    c = new Control(Control::Close, look, this);
                if (!c)
                    continue;
                controls << c;
                row->addWidget(c, 0, Qt::AlignVCenter);
                connect(c, &QAbstractButton::clicked, this, [this, c] {
                    QWidget *w = window();
                    if (c->kind == Control::Minimize)
                        w->showMinimized();
                    else if (c->kind == Control::Close)
                        w->close();
                    else
                        w->isMaximized() ? w->showNormal() : w->showMaximized();
                });
            }
        };
        add(sides.value(0));
        row->addStretch(1);
        row->addWidget(pill, 0, Qt::AlignVCenter);
        row->addWidget(start, 0, Qt::AlignVCenter);
        add(sides.value(1));
        title->raise();
        restyle();
    }

    void restyle()
    {
        const Look &l = *look;
        setFixedHeight(l.px(34));
        layout()->setContentsMargins(l.px(6), 0, l.px(6), 0);
        layout()->setSpacing(l.px(4));
        // (A height of their own: a style sheet rounds an end only up to half the height.)
        const int tall = l.px(22);
        pill->setFixedHeight(tall);
        start->setFixedHeight(tall);
        pill->layout()->setContentsMargins(l.px(10), 0, l.px(10), 0);
        pill->layout()->setSpacing(l.px(6));
        dot->setFixedSize(l.px(6), l.px(6));
        setStyleSheet(QString("QLabel { color: %1; font-size: %2px; font-weight: 500; background: transparent; }"
                              "#pill { background: %3; border-radius: %4px; } #pill QLabel { font-size: %5px; font-weight: 400; }"
                              "#start { font-size: %5px; font-weight: 600; padding: 0 %6px; border: none; border-radius: %4px; background: %7; color: %8; }"
                              "#start:hover { background: %9; } #start:pressed { background: %10; }"
                              "QToolTip { color: %7; background: %11; border: 1px solid %12; padding: 4px 6px; }")
                              .arg(l.muted)
                              .arg(l.px(13))
                              .arg(rgba(l.fg, 0.06))
                              .arg(tall / 2)
                              .arg(l.px(12))
                              .arg(l.px(10))
                              .arg(l.fg, l.bg, rgba(l.fg, 0.85), rgba(l.fg, 0.7), l.panel, l.line));
        for (Control *c : controls) {
            c->setFixedSize(c->sizeHint());
            c->update();
        }
        place();
        update();
    }

    void state(bool maximized)
    {
        if (maximize)
            maximize->kind = maximized ? Control::Restore : Control::Maximize;
        if (maximize)
            maximize->setToolTip(maximized ? "Restore" : "Maximize");
        update();
    }

signals:
    void startAsked();

protected:
    // The title sits in the middle of the bar, whatever stands on either side.
    void place()
    {
        int left = 0, right = width();
        for (QWidget *w : findChildren<QWidget *>(Qt::FindDirectChildrenOnly)) {
            if (w == title || !w->isVisibleTo(this))
                continue;
            if (w->geometry().center().x() < width() / 2)
                left = std::max(left, w->geometry().right());
            else
                right = std::min(right, w->geometry().left());
        }
        const int room = std::max(0, 2 * std::min(width() / 2 - left, right - width() / 2) - look->px(16));
        title->setGeometry((width() - room) / 2, 0, room, height());
    }
    void resizeEvent(QResizeEvent *) override { place(); }
    bool event(QEvent *e) override
    {
        if (e->type() == QEvent::LayoutRequest || e->type() == QEvent::WindowActivate || e->type() == QEvent::WindowDeactivate) {
            QTimer::singleShot(0, this, [this] { place(); update(); });
        }
        return QWidget::event(e);
    }
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        // The bar is the rail's colour and runs into it, with no line between them: a hairline there
        // read as a short white line at the top of the list in the dark theme.
        p.fillRect(rect(), QColor(look->panel));
    }
    void mousePressEvent(QMouseEvent *e) override
    {
        if (e->button() == Qt::LeftButton && window()->windowHandle())
            window()->windowHandle()->startSystemMove();
    }
    void mouseDoubleClickEvent(QMouseEvent *e) override
    {
        if (e->button() == Qt::LeftButton)
            window()->isMaximized() ? window()->showNormal() : window()->showMaximized();
    }
};

// ---- A window ----------------------------------------------------------------------------------

class Win : public QWidget {
    Q_OBJECT
public:
    int id;
    const Look *look;
    Bar *bar;
    View *view;
    Page *page;
    QTimer sized;
    Bridge *bridge = nullptr;
    std::unique_ptr<QWebEngineView> inspector;
    QWebEngineProfile *profile;
    bool devtools, probing;
    // What the page in the window does with the app (../src/said.rs `Can`): it pastes where the
    // owner is when handed the paste keys, and it announces a file before it offers one. Both
    // are said off by the app's own script as a document starts, and on by the page itself.
    bool pastes = false, announces = false;
    // The file the page announced, and until when it may arrive.
    QUrl saving;
    qint64 savingUntil = 0;

    Win(int number, QWebEngineProfile *ofProfile, const Look *colors, bool inspected, bool measured) : id(number), look(colors), profile(ofProfile), devtools(inspected), probing(measured)
    {
        setWindowFlags(Qt::Window | Qt::FramelessWindowHint);
        setWindowTitle("Keel");
        setMinimumSize(360, 240);
        auto *col = new QVBoxLayout(this);
        col->setSpacing(0);
        bar = new Bar(look, this);
        view = new View(this);
        view->devtools = devtools;
        col->addWidget(bar);
        col->addWidget(view, 1);
        frame();

        if (devtools) {
            inspector = std::make_unique<QWebEngineView>();
            inspector->setWindowTitle("Keel inspector");
            inspector->resize(1100, 700);
        }
        makePage();
        connect(bar, &Bar::startAsked, this, [this] { say({{"t", "start"}, {"win", id}}); });
        sized.setSingleShot(true);
        sized.setInterval(250);
        connect(&sized, &QTimer::timeout, this, [this] { tellSize(); });
    }
    // The window's page: what it may do, its channel to the app, and what it tells the app. Made
    // with the window, and made anew when its process ended (`renew`).
    void makePage()
    {
        // (The page before it, a child of the view, goes with this: its channel and its object too.)
        page = new Page(profile, id, devtools, probing, view);
        view->setPage(page);
        QWebEngineSettings *s = page->settings();
        using S = QWebEngineSettings;
        // No frame reads or writes the clipboard through the engine: the app does it for the
        // page of the daemon's own origin, at the owner's press (../src/clip.rs).
        s->setAttribute(S::JavascriptCanAccessClipboard, false);
        s->setAttribute(S::JavascriptCanPaste, false);
        // A window is opened by the app, for a place of the page, on the owner's click.
        s->setAttribute(S::JavascriptCanOpenWindows, false);
        s->setAttribute(S::LocalContentCanAccessFileUrls, false);
        s->setAttribute(S::LocalContentCanAccessRemoteUrls, false);
        s->setAttribute(S::NavigateOnDropEnabled, false);
        s->setAttribute(S::ScreenCaptureEnabled, false);
        s->setAttribute(S::FullScreenSupportEnabled, false);
        // A load that failed is the daemon gone: the app's calm page, not the engine's.
        s->setAttribute(S::ErrorPageEnabled, false);
        // A link to another program (mailto and the like) starts nothing by itself.
        s->setUnknownUrlSchemePolicy(S::DisallowUnknownUrlSchemes);
        page->setBackgroundColor(QColor(look->bg));

        auto *channel = new QWebChannel(page);
        bridge = new Bridge(id, probing, page);
        channel->registerObject("keel", bridge);
        page->setWebChannel(channel);

        // The engine grants content nothing: not the clipboard, not a device, not a place.
        // The one exception is the microphone (audio capture only), for the page of the daemon's own origin, once, after
        // the page said at the owner's press that it is about to ask (the "mic" line, ../src/qt.rs).
        connect(page, &QWebEnginePage::permissionRequested, this, [this](QWebEnginePermission p) {
            const bool mine = p.permissionType() == QWebEnginePermission::PermissionType::MediaAudioCapture && page->mode == Page::App && !page->origin.isEmpty()
                && p.origin().toString(QUrl::RemoveUserInfo | QUrl::RemovePath | QUrl::RemoveQuery | QUrl::RemoveFragment) == page->origin
                && QDateTime::currentMSecsSinceEpoch() <= page->micUntil;
            page->micUntil = 0;
            if (probing)
                say({{"t", "probe"}, {"s", QString("PERMISSION audio_only=%1 given=%2").arg(p.permissionType() == QWebEnginePermission::PermissionType::MediaAudioCapture ? "true" : "false", mine ? "true" : "false")}});
            if (mine)
                p.grant();
            else
                p.deny();
        });
        // No window opens by itself: the app is told the address and whether the owner asked.
        connect(page, &QWebEnginePage::newWindowRequested, this, [this](QWebEngineNewWindowRequest &r) {
            say({{"t", "nav"}, {"win", id}, {"kind", "new-window"}, {"url", r.requestedUrl().toString(QUrl::FullyEncoded)}, {"gesture", r.isUserInitiated()}});
        });
        connect(page, &QWebEnginePage::loadingChanged, this, [this](const QWebEngineLoadingInfo &info) {
            if (info.status() == QWebEngineLoadingInfo::LoadStartedStatus)
                return;
            const char *how = info.status() == QWebEngineLoadingInfo::LoadSucceededStatus ? "ok" : info.status() == QWebEngineLoadingInfo::LoadFailedStatus ? "failed" : "stopped";
            say({{"t", "loaded"}, {"win", id}, {"url", info.url().toString(QUrl::FullyEncoded)}, {"how", how}, {"code", info.errorCode()}});
        });
        connect(page, &QWebEnginePage::urlChanged, this, [this](const QUrl &url) { say({{"t", "url"}, {"win", id}, {"url", url.toString(QUrl::FullyEncoded)}}); });
        // The page's title is the window's name on the desktop (the overview, the task switcher).
        connect(page, &QWebEnginePage::titleChanged, this, [this](const QString &t) { setWindowTitle(t.isEmpty() || t.startsWith("data:") || t.startsWith("about:") ? "Keel" : t); });
        // The page's own process ended (a crash, or the script heap's bound): the app is told, and
        // says whether the page is loaded again (it counts: a page that keeps ending is left).
        connect(page, &QWebEnginePage::renderProcessTerminated, this, [this](QWebEnginePage::RenderProcessTerminationStatus status, int code) {
            static const char *names[] = {"normal", "abnormal", "crashed", "killed"};
            forget();
            say({{"t", "crashed"}, {"win", id}, {"status", names[std::clamp(int(status), 0, 3)]}, {"code", code}});
        });
        if (inspector) {
            page->setDevToolsPage(inspector->page());
            connect(page->action(QWebEnginePage::InspectElement), &QAction::triggered, inspector.get(), &QWidget::show);
        }
    }
    // A new page in the window, in the place of one whose process ended. The engine does not
    // always put the app's script into such a page again, however it is loaded (of two windows
    // whose pages ended together, one came back drawn and working and cut off from the app more
    // often than not): a page of its own, new, has it. The window stays as it is.
    void renew()
    {
        forget();
        makePage();
        page->setBackgroundColor(QColor(look->bg));
    }
    // What the page said it does with the app went with the page: the one that comes next says
    // so itself, or says nothing (a page with none of the app's script in it is a page like a
    // browser tab's: its paste keys are the engine's, and its files are kept by the rule for a
    // page that announces none).
    void forget()
    {
        pastes = announces = false;
        savingUntil = 0;
    }
    // A window the owner closed is not destroyed: this engine keeps the buffers of a page whose
    // process went (two a window, for the life of the program; a bare program of a window and a
    // web view shows the same, and so does discarding the page or sending it to another
    // process), while a window that is hidden and shown again keeps what it has. It is emptied
    // in place and put aside, and the next window asked for is this one under a new number. Its
    // page's process stays, and gives its memory back by itself when it has rested.
    void retire()
    {
        hide();
        forget();
        page->mode = Page::Away;
        page->origin.clear();
        page->scripts().clear();
        view->setUrl(QUrl("about:blank"));
        bar->title->setText("Keel");
        bar->pill->hide();
        bar->start->hide();
        setWindowTitle("Keel");
    }
    void renumber(int number)
    {
        id = number;
        page->win = number;
        bridge->win = number;
        page->history()->clear();
        setWindowState(Qt::WindowNoState);
    }

    void tellSize() { say({{"t", "size"}, {"win", id}, {"w", width()}, {"h", height()}, {"maximized", isMaximized()}}); }

    // A line around the window while it floats: it has no frame of the desktop's to set it off.
    void frame()
    {
        const int edge = isMaximized() || isFullScreen() ? 0 : 1;
        layout()->setContentsMargins(edge, edge, edge, edge);
        bar->state(isMaximized());
        update();
    }

    void restyle()
    {
        page->setBackgroundColor(QColor(look->bg));
        bar->restyle();
        view->menuStyle = QString("QMenu { background: %1; color: %2; border: 1px solid %3; padding: %4px; font-size: %5px; }"
                                  "QMenu::item { padding: %6px %7px; border-radius: %8px; } QMenu::item:selected { background: %9; }"
                                  "QMenu::item:disabled { color: %10; } QMenu::separator { height: 1px; background: %3; margin: %4px %11px; }")
                              .arg(look->panel, look->fg, look->line)
                              .arg(look->px(4))
                              .arg(look->px(13))
                              .arg(look->px(5))
                              .arg(look->px(14))
                              .arg(look->px(5))
                              .arg(rgba(look->fg, 0.08), rgba(look->muted, 0.6))
                              .arg(look->px(6));
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        // The line around the window while it floats, a little stronger than the page's own
        // hairlines: on a desktop that draws no shadow for it, it is what sets the window off.
        QPainter p(this);
        p.fillRect(rect(), QColor(look->bg));
        p.fillRect(rect(), faded(look->fg, look->dark ? 0.26 : 0.34));
    }
    void closeEvent(QCloseEvent *e) override
    {
        // The app decides: it hides the main window while a tray shows the mark, and closes it otherwise.
        e->ignore();
        say({{"t", "close"}, {"win", id}});
    }
    void resizeEvent(QResizeEvent *) override { sized.start(); }
    void changeEvent(QEvent *e) override
    {
        if (e->type() == QEvent::WindowStateChange) {
            frame();
            sized.start();
        }
        QWidget::changeEvent(e);
    }
};

// ---- A question before something that cannot be taken back -------------------------------------

class Question : public QDialog {
public:
    Look l;
    Question(QWidget *parent, const Look &look, const QString &question, const QString &detail, const QString &agree) : QDialog(parent, Qt::Dialog | Qt::FramelessWindowHint), l(look)
    {
        setModal(true);
        setWindowTitle("Keel");
        // (A small sheet with round corners: its corners are see-through.)
        setAttribute(Qt::WA_TranslucentBackground);
        const int round = l.px(12);
        auto *col = new QVBoxLayout(this);
        col->setContentsMargins(1, 1, 1, 1);
        col->setSpacing(0);
        auto *words = new QVBoxLayout;
        words->setContentsMargins(l.px(28), l.px(24), l.px(28), l.px(22));
        words->setSpacing(l.px(8));
        auto *head = new QLabel(question, this);
        head->setObjectName("head");
        head->setAlignment(Qt::AlignHCenter);
        auto *body = new QLabel(detail, this);
        body->setWordWrap(true);
        body->setFixedWidth(l.px(410));
        words->addWidget(head);
        words->addWidget(body);
        col->addLayout(words);
        auto *row = new QHBoxLayout;
        row->setSpacing(0);
        auto *no = new QPushButton("Cancel", this), *yes = new QPushButton(agree, this);
        no->setObjectName("first");
        yes->setObjectName("last");
        // The safe answer is the one Return gives, and the one that shows the focus.
        no->setDefault(true);
        yes->setAutoDefault(false);
        for (QPushButton *b : {no, yes}) {
            b->setFixedHeight(l.px(40));
            b->setCursor(Qt::ArrowCursor);
            row->addWidget(b, 1);
        }
        col->addLayout(row);
        connect(no, &QPushButton::clicked, this, &QDialog::reject);
        connect(yes, &QPushButton::clicked, this, &QDialog::accept);
        setStyleSheet(QString("QLabel { color: %1; font-size: %2px; background: transparent; } #head { color: %3; font-size: %4px; font-weight: 600; }"
                              "QPushButton { border: none; border-top: 1px solid %5; background: transparent; color: %3; font-size: %2px; font-weight: 500; }"
                              "QPushButton#first { border-right: 1px solid %5; border-bottom-left-radius: %6px; } QPushButton#last { border-bottom-right-radius: %6px; }"
                              "QPushButton:hover { background: %7; } QPushButton:pressed { background: %8; }"
                              "QPushButton:focus { border: 2px solid %9; font-weight: 600; }")
                          .arg(l.muted)
                          .arg(l.px(13))
                          .arg(l.fg)
                          .arg(l.px(15))
                          .arg(l.line)
                          .arg(round - 1)
                          .arg(rgba(l.fg, 0.06), rgba(l.fg, 0.12), l.need));
        no->setFocus();
    }

protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.setPen(QPen(QColor(l.line), 1));
        p.setBrush(QColor(l.panel));
        p.drawRoundedRect(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5), l.px(12), l.px(12));
    }
};

// ---- The app's commands ------------------------------------------------------------------------

class Host : public QObject {
    Q_OBJECT
public:
    QWebEngineProfile *profile;
    Look look;
    bool devtools = false, probing = false;
    QHash<int, Win *> wins;
    QList<Win *> spare; // closed windows, kept for the next one asked for (see Win::retire)
    QByteArray pending;
    QHash<int, qint64> pressed, lastPress;
    // A paste key taken from the engine for a page that pastes where the owner is: the key,
    // where it was going and whose window that is, until the page says whose paste it is.
    std::unique_ptr<QKeyEvent> heldKey;
    QPointer<QObject> heldTo;
    int heldFor = 0;
    bool passing = false;
    Qt::Edges gripping;
    bool gripped = false;

    Host(QWebEngineProfile *pages, bool inspected, bool measured) : profile(pages), devtools(inspected), probing(measured)
    {
        auto *in = new QSocketNotifier(appIn, QSocketNotifier::Read, this);
        connect(in, &QSocketNotifier::activated, this, [this, in] {
            char buf[65536];
            const ssize_t n = ::read(appIn, buf, sizeof buf);
            if (n <= 0) {
                // The app is gone: its windows go with it. (Not quit(): that asks every window to
                // close first, and a window here leaves the answer to the app.)
                in->setEnabled(false);
                QCoreApplication::exit(0);
                return;
            }
            pending.append(buf, n);
            // The app's lines are short. One that never ends is not the app's.
            if (pending.size() > 64 * 1024 * 1024 && !pending.contains('\n')) {
                ::fprintf(stderr, "keel-desktop-qt: a line of the app's that did not end was dropped\n");
                pending.clear();
            }
            for (qsizetype at; (at = pending.indexOf('\n')) >= 0;) {
                const QJsonObject m = QJsonDocument::fromJson(pending.left(at)).object();
                pending.remove(0, at + 1);
                if (!m.isEmpty())
                    told(m);
            }
        });
        // A file the page offers is saved to the downloads folder under a free name: never over
        // a file, never outside that folder, never into the home folder.
        // And only at the owner's press in that window, a moment before: a script, in the page or in
        // a frame the page lets keep files, saves nothing by itself.
        connect(profile, &QWebEngineProfile::downloadRequested, this, [this](QWebEngineDownloadRequest *d) {
            if (d->isSavePageDownload())
                return;
            // A file is kept from the daemon's own API only, and from a page that announces its
            // files only the one it announced a moment before, at the owner's press (the app
            // checked both, ../src/clip.rs): a frame of content can say nothing to the app, so a
            // script in one keeps nothing, whatever the owner is pressing meanwhile.
            const auto *from = qobject_cast<Page *>(d->page());
            Win *w = from ? wins.value(from->win) : nullptr;
            const qint64 now = QDateTime::currentMSecsSinceEpoch();
            bool keep = false;
            if (w && keepable(d->url().toString(QUrl::FullyEncoded), from->origin)) {
                if (w->announces) {
                    keep = now <= w->savingUntil && d->url() == w->saving;
                    if (keep)
                        w->savingUntil = 0;
                } else {
                    keep = now - lastPress.value(w->id) <= KEEP_MS;
                }
            }
            if (!keep) {
                say({{"t", "download-refused"}, {"win", from ? from->win : 0}});
                d->cancel();
                return;
            }
            const QString home = QDir::homePath();
            QString folder = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
            if (folder.isEmpty() || QDir(folder) == QDir(home))
                folder = home + "/Downloads";
            QDir().mkpath(folder);
            d->setDownloadDirectory(folder);
            d->setDownloadFileName(freeName(folder, d->suggestedFileName()));
            d->accept();
            say({{"t", "download"}, {"path", folder + "/" + d->downloadFileName()}});
        });
        qApp->installEventFilter(this);
    }

    void told(const QJsonObject &m)
    {
        const QString t = m["t"].toString();
        Win *w = wins.value(m["win"].toInt());
        if (t == "open") {
            const int id = m["win"].toInt();
            if (wins.contains(id))
                return;
            if (spare.isEmpty()) {
                w = new Win(id, profile, &look, devtools, probing);
            } else {
                w = spare.takeLast();
                w->renumber(id);
            }
            wins.insert(id, w);
            w->restyle();
            w->resize(std::max(360, m["w"].toInt(1280)), std::max(240, m["h"].toInt(860)));
            if (m["maximized"].toBool())
                w->setWindowState(Qt::WindowMaximized);
        } else if (t == "look") {
            look = lookOf(m["look"].toObject());
            for (Win *x : std::as_const(wins))
                x->restyle();
        } else if (t == "quit") {
            QCoreApplication::exit(0);
        } else if (t == "ping") {
            // (Answered from the loop that draws: a program that hangs does not answer.)
            say({{"t", "pong"}});
        } else if (t == "confirm") {
            const int id = m["id"].toInt();
            QWidget *over = QApplication::activeWindow();
            if (!over && !wins.isEmpty())
                over = *wins.constBegin();
            auto *q = new Question(over, look, m["question"].toString(), m["detail"].toString(), m["agree"].toString());
            q->setAttribute(Qt::WA_DeleteOnClose);
            connect(q, &QDialog::finished, this, [id](int r) { say({{"t", "confirmed"}, {"id", id}, {"yes", r == QDialog::Accepted}}); });
            q->open();
        } else if (t == "clip-write") {
            QGuiApplication::clipboard()->setText(m["text"].toString());
        } else if (!w) {
            return;
        } else if (t == "load") {
            w->forget();
            w->page->mode = Page::App;
            w->page->origin = m["origin"].toString();
            script(w, senderScript() + "\n" + m["script"].toString());
            w->bar->title->setText(m["title"].toString("Keel"));
            w->view->load(QUrl(m["url"].toString()));
        } else if (t == "html") {
            w->forget();
            w->page->mode = Page::Away;
            w->page->origin.clear();
            script(w, senderScript());
            w->bar->title->setText("Keel");
            w->view->setHtml(m["html"].toString(), QUrl("about:blank"));
        } else if (t == "renew") {
            if (heldFor == w->id)
                heldKey.reset();
            w->renew();
        } else if (t == "js") {
            w->page->runJavaScript(m["src"].toString());
        } else if (t == "pill") {
            w->bar->pill->setVisible(m["show"].toBool());
            w->bar->pillText->setText(m["text"].toString());
            w->bar->dot->setVisible(m["dot"].toBool());
            w->bar->pill->setToolTip(m["tip"].toString());
            w->bar->start->setText(m["label"].toString("Start"));
            w->bar->start->setVisible(m["start"].toBool());
        } else if (t == "present") {
            // With the desktop's activation token of the request the window takes the focus;
            // without one the desktop decides.
            const QByteArray token = m["token"].toString().toUtf8();
            if (!token.isEmpty())
                qputenv("XDG_ACTIVATION_TOKEN", token);
            w->isMinimized() ? w->showNormal() : w->show();
            w->raise();
            w->activateWindow();
            w->view->setFocus();
            qunsetenv("XDG_ACTIVATION_TOKEN");
        } else if (t == "hide") {
            w->hide();
        } else if (t == "close") {
            wins.remove(w->id);
            pressed.remove(w->id);
            lastPress.remove(w->id);
            w->retire();
            spare << w;
        } else if (t == "clip-read") {
            read(w->id, m["id"].toDouble(), m["edge"].toInt());
        } else if (t == "can") {
            w->pastes = m["paste"].toBool();
            w->announces = m["saving"].toBool();
            if (!w->announces)
                w->savingUntil = 0;
        } else if (t == "mic") {
            w->page->micUntil = QDateTime::currentMSecsSinceEpoch() + MIC_MS;
        } else if (t == "saving") {
            w->saving = QUrl(m["url"].toString());
            w->savingUntil = QDateTime::currentMSecsSinceEpoch() + m["ms"].toInt();
        } else if (t == "paste-key") {
            // The paste the page was handed is the engine's to make (the owner is in a frame of
            // content by their own act): the key that was held goes on to where it was going.
            if (heldKey && heldFor == w->id && heldTo) {
                passing = true;
                // (As a key arrives: offered as a shortcut, then pressed.)
                QKeyEvent offer(QEvent::ShortcutOverride, heldKey->key(), heldKey->modifiers(), heldKey->nativeScanCode(), heldKey->nativeVirtualKey(), heldKey->nativeModifiers(), heldKey->text());
                QCoreApplication::sendEvent(heldTo, &offer);
                QCoreApplication::sendEvent(heldTo, heldKey.get());
                passing = false;
            }
            heldKey.reset();
        }
    }

    // The scripts put into the top frame of what the window loads next.
    void script(Win *w, const QString &source)
    {
        QWebEngineScript s;
        s.setName("keel");
        s.setInjectionPoint(QWebEngineScript::DocumentCreation);
        s.setWorldId(QWebEngineScript::MainWorld);
        s.setRunsOnSubFrames(false);
        s.setSourceCode(source);
        w->page->scripts().clear();
        w->page->scripts().insert(s);
    }

    // What the clipboard holds, for the page that asked at the owner's press: its text, and a
    // picture as PNG no larger than the page keeps one. The picture is decoded, scaled and
    // encoded off the main loop.
    void read(int win, double id, int edge)
    {
        const QMimeData *mime = QGuiApplication::clipboard()->mimeData();
        QJsonObject base{{"t", "clip"}, {"win", win}, {"id", id}};
        if (!mime)
            return say(base);
        if (mime->hasText())
            base["text"] = mime->text();
        QByteArray raw;
        for (const char *format : {"image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif", "image/tiff"}) {
            if (mime->hasFormat(format)) {
                raw = mime->data(format);
                break;
            }
        }
        QImage direct;
        if (raw.isEmpty() && mime->hasImage())
            direct = qvariant_cast<QImage>(mime->imageData());
        if (raw.isEmpty() && direct.isNull())
            return say(base);
        QThreadPool::globalInstance()->start([base, raw, direct, edge]() mutable {
            QImage image = raw.isEmpty() ? direct : QImage::fromData(raw);
            base["picture"] = true;
            if (!image.isNull()) {
                const int w = image.width(), h = image.height(), longer = std::max(w, h);
                base["from"] = QJsonArray{w, h};
                if (edge > 0 && longer > edge) {
                    const double by = double(edge) / longer;
                    image = image.scaled(std::max(1, int(std::lround(w * by))), std::max(1, int(std::lround(h * by))), Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
                }
                QByteArray png;
                QBuffer out(&png);
                out.open(QIODevice::WriteOnly);
                if (image.save(&out, "PNG")) {
                    base["png"] = QString::fromLatin1(png.toBase64());
                    base["w"] = image.width();
                    base["h"] = image.height();
                }
            }
            say(base);
        });
    }

protected:
    // The owner's presses in a window are told to the app before the page sees them (it decides
    // by them when the clipboard may be used); the text size keys drive the page's own setting;
    // and the window is resized from its edges, since it has no frame of the desktop's.
    bool eventFilter(QObject *o, QEvent *e) override
    {
        const QEvent::Type type = e->type();
        if (passing || (type != QEvent::KeyPress && type != QEvent::ShortcutOverride && type != QEvent::MouseButtonPress && type != QEvent::MouseButtonRelease && type != QEvent::MouseMove && type != QEvent::Leave))
            return false;
        auto *widget = qobject_cast<QWidget *>(o);
        Win *w = widget ? qobject_cast<Win *>(widget->window()) : nullptr;
        if (!w)
            return false;
        // A key is offered as a shortcut before it is pressed. The engine takes the paste keys
        // at that offer and remembers "paste" for the press that follows: with the press taken
        // from it (below), it would paste at the owner's next key instead. So the offer is
        // taken from it too.
        if (type == QEvent::ShortcutOverride)
            return takesPaste(w, widget, static_cast<QKeyEvent *>(e));
        // (A button's release too: a click is made of both, however long the button was held.)
        if (type == QEvent::KeyPress || type == QEvent::MouseButtonPress || type == QEvent::MouseButtonRelease) {
            const qint64 now = QDateTime::currentMSecsSinceEpoch();
            lastPress.insert(w->id, now);
            if (now - pressed.value(w->id) > 120) {
                pressed.insert(w->id, now);
                say({{"t", "input"}, {"win", w->id}});
            }
        }
        if (type == QEvent::KeyPress) {
            auto *k = static_cast<QKeyEvent *>(e);
            // The paste keys, in a window whose page pastes where the owner is: taken from the
            // engine, which would hand the clipboard to whatever frame has the keyboard at
            // this instant (one the owner pressed in a moment ago may take it by script). The
            // page is told, and what is pasted goes through the app (ui/src/lib/paste-key.ts).
            if (takesPaste(w, widget, k)) {
                heldKey.reset(k->clone());
                heldTo = o;
                heldFor = w->id;
                say({{"t", "keys"}, {"win", w->id}, {"paste", true}});
                return true;
            }
            const Qt::KeyboardModifiers mods = k->modifiers() & (Qt::ControlModifier | Qt::AltModifier | Qt::MetaModifier);
            if (mods != Qt::ControlModifier)
                return false;
            const char *step = nullptr;
            switch (k->key()) {
            case Qt::Key_Plus:
            case Qt::Key_Equal:
                step = "up";
                break;
            case Qt::Key_Minus:
                step = "down";
                break;
            case Qt::Key_0:
                step = "reset";
                break;
            default:
                return false;
            }
            say({{"t", "keys"}, {"win", w->id}, {"step", step}});
            return true;
        }
        if (type == QEvent::Leave) {
            grip(Qt::Edges());
            return false;
        }
        if (type == QEvent::MouseButtonRelease)
            return false;
        auto *m = static_cast<QMouseEvent *>(e);
        Qt::Edges edges;
        if (!w->isMaximized() && !w->isFullScreen() && m->buttons() == (type == QEvent::MouseButtonPress ? m->button() : Qt::NoButton)) {
            const QPointF at = widget->mapTo(w, m->position());
            const int zone = 5;
            if (at.x() < zone)
                edges |= Qt::LeftEdge;
            if (at.x() >= w->width() - zone)
                edges |= Qt::RightEdge;
            if (at.y() < zone)
                edges |= Qt::TopEdge;
            if (at.y() >= w->height() - zone)
                edges |= Qt::BottomEdge;
        }
        grip(edges);
        if (edges && type == QEvent::MouseButtonPress && m->button() == Qt::LeftButton && w->windowHandle()) {
            w->windowHandle()->startSystemResize(edges);
            return true;
        }
        return false;
    }

    // Whether a key in the window is a paste key the app takes from the engine: in a window
    // whose page pastes where the owner is, with the keyboard in the page.
    static bool takesPaste(const Win *w, const QWidget *widget, const QKeyEvent *k)
    {
        return w->pastes && w->page->mode == Page::App && isPaste(k) && w->view->isAncestorOf(widget);
    }

    // The keys that paste: Ctrl+V, Ctrl+Shift+V and Shift+Insert.
    static bool isPaste(const QKeyEvent *k)
    {
        const Qt::KeyboardModifiers mods = k->modifiers() & (Qt::ControlModifier | Qt::ShiftModifier | Qt::AltModifier | Qt::MetaModifier);
        if (k->key() == Qt::Key_V)
            return mods == Qt::ControlModifier || mods == (Qt::ControlModifier | Qt::ShiftModifier);
        return k->key() == Qt::Key_Insert && mods == Qt::ShiftModifier;
    }

    // The pointer's shape over an edge the window is resized from.
    void grip(Qt::Edges edges)
    {
        if (edges == gripping && gripped == bool(edges))
            return;
        if (gripped)
            QGuiApplication::restoreOverrideCursor();
        gripped = bool(edges);
        gripping = edges;
        if (!edges)
            return;
        const bool h = edges & (Qt::LeftEdge | Qt::RightEdge), v = edges & (Qt::TopEdge | Qt::BottomEdge);
        const bool falling = (edges == (Qt::LeftEdge | Qt::TopEdge)) || (edges == (Qt::RightEdge | Qt::BottomEdge));
        QGuiApplication::setOverrideCursor(h && v ? (falling ? Qt::SizeFDiagCursor : Qt::SizeBDiagCursor) : h ? Qt::SizeHorCursor : Qt::SizeVerCursor);
    }
};

// The engine's flags from the environment, without the ones that open its debugging port or take
// its sandbox off (a quoted value is one word). What was left out is added to `dropped`.
static QByteArray ownFlags(const QByteArray &inherited, QStringList *dropped)
{
    static const char *never[] = {"--remote-debugging", "--remote-allow-origins", "--no-sandbox", "--disable-web-security", "--disable-seccomp-filter-sandbox",
                                  "--disable-setuid-sandbox", "--disable-namespace-sandbox", "--disable-gpu-sandbox", "--single-process"};
    QByteArray kept, word;
    char quote = 0;
    const auto take = [&] {
        if (word.isEmpty())
            return;
        bool drop = false;
        for (const char *n : never)
            drop = drop || word.startsWith(n);
        if (drop)
            *dropped << QString::fromUtf8(word);
        else
            kept += (kept.isEmpty() ? "" : " ") + word;
        word.clear();
    };
    for (const char c : inherited) {
        if (quote) {
            quote = c == quote ? 0 : quote;
            word += c;
        } else if (c == '"' || c == '\'') {
            quote = c;
            word += c;
        } else if (c == ' ' || c == '\t' || c == '\n') {
            take();
        } else {
            word += c;
        }
    }
    take();
    return kept;
}

// The engine serves its own files (the channel's library among them) to any frame that asks by
// their address. This program reads the one it needs itself: no page gets any.
class OwnFiles : public QWebEngineUrlRequestInterceptor {
public:
    using QWebEngineUrlRequestInterceptor::QWebEngineUrlRequestInterceptor;
    void interceptRequest(QWebEngineUrlRequestInfo &info) override
    {
        if (info.requestUrl().scheme() == "qrc")
            info.block(true);
    }
};

// What draws for this desktop: the name of its OpenGL renderer (empty when it has none).
static QString glRenderer()
{
    QOpenGLContext context;
    if (!context.create())
        return {};
    QOffscreenSurface surface;
    surface.setFormat(context.format());
    surface.create();
    if (!surface.isValid() || !context.makeCurrent(&surface))
        return {};
    const auto *name = reinterpret_cast<const char *>(context.functions()->glGetString(GL_RENDERER));
    const QString renderer = QString::fromLatin1(name ? name : "");
    context.doneCurrent();
    return renderer;
}

// Whether the windows are drawn with Vulkan: under Wayland with the one driver the engine
// shares no buffers with (it then draws its pages with Vulkan, which a window drawn with
// OpenGL cannot show).
static bool vulkanWindow(const QString &platform, const QString &renderer)
{
    return platform.startsWith("wayland") && renderer.contains("NVIDIA", Qt::CaseInsensitive);
}

// Whether the desktop's OpenGL is the processor's own work (no graphics card behind it: a
// virtual machine, a remote desktop). The windows are then drawn without OpenGL at all: the
// engine's pages reach the screen the same, at a quarter of the processor's time and with less
// memory held, since nothing is drawn twice.
static bool softwareGl(const QString &renderer)
{
    for (const char *name : {"llvmpipe", "softpipe", "swrast", "SwiftShader"})
        if (renderer.contains(QLatin1String(name), Qt::CaseInsensitive))
            return true;
    return false;
}

// `--self-test FILE`: the table of paths the main frame may and may not show (lines of
// "ok PATH" and "no PATH"), the same one the app's own rule is tested with.
static int selfTest(const QString &file)
{
    QFile f(file);
    if (!f.open(QIODevice::ReadOnly)) {
        ::fprintf(stderr, "keel-desktop-qt: cannot read %s\n", qPrintable(file));
        return 2;
    }
    int bad = 0, n = 0;
    for (const QByteArray &raw : f.readAll().split('\n')) {
        const QString line = QString::fromUtf8(raw);
        if (line.isEmpty() || line.startsWith('#'))
            continue;
        const bool want = line.startsWith("ok ");
        const QString path = line.mid(3);
        n++;
        if (pagePath(path) != want || mayShow("http://127.0.0.1:1" + path, "http://127.0.0.1:1") != want) {
            ::fprintf(stderr, "keel-desktop-qt: %s\n", qPrintable(line));
            bad++;
        }
    }
    ::printf("%d of %d paths decided as the table says\n", n - bad, n);
    // And the flags this program does not take from the environment.
    QStringList dropped;
    const QByteArray kept = ownFlags("--remote-debugging-port=9222 --js-flags=\"--a --b\" --no-sandbox  --disable-gpu --remote-allow-origins=* --disable-web-security", &dropped);
    const bool flagsRight = kept == "--js-flags=\"--a --b\" --disable-gpu" && dropped.size() == 4;
    ::printf("the flags of the environment: %s\n", flagsRight ? "kept and dropped as they should be" : "WRONG");
    // And the files it keeps: the daemon's own, from its API (as ../src/links.rs has it).
    const QString o = "http://127.0.0.1:47950";
    bool filesRight = keepable(o + "/api/attachments/7?name=a.png", o) && !keepable(o + "/api/x", "");
    for (const char *no : {"blob:null/2b7c8a5e", "blob:http://127.0.0.1:47950/2b7c8a5e", "data:text/plain,hello", "http://127.0.0.1:47950/portal/s/k/5173/x.bin",
                           "http://127.0.0.1:47950.evil.example/api/x", "http://127.0.0.1:5173/api/x", "https://example.com/api/x", "http://127.0.0.1:47950/apix", ""})
        filesRight = filesRight && !keepable(no, o);
    ::printf("the files it keeps: %s\n", filesRight ? "the daemon's own and no others" : "WRONG");
    // And where its windows are drawn with Vulkan.
    const bool glRight = vulkanWindow("wayland", "NVIDIA GeForce RTX 4070/PCIe/SSE2") && vulkanWindow("wayland-egl", "NVIDIA GeForce GTX 1650/PCIe/SSE2") &&
        !vulkanWindow("xcb", "NVIDIA GeForce RTX 4070/PCIe/SSE2") && !vulkanWindow("wayland", "Mesa Intel(R) Graphics (ADL GT2)") &&
        !vulkanWindow("wayland", "AMD Radeon Graphics (radeonsi, renoir)") && !vulkanWindow("wayland", "llvmpipe (LLVM 20.1.2, 256 bits)") && !vulkanWindow("wayland", "");
    ::printf("where its windows are drawn with Vulkan: %s\n", glRight ? "as the table says" : "WRONG");
    // And where without OpenGL: only where the desktop's OpenGL is the processor's own work.
    const bool softRight = softwareGl("llvmpipe (LLVM 20.1.2, 256 bits)") && softwareGl("softpipe") && softwareGl("Google SwiftShader") &&
        !softwareGl("NVIDIA GeForce RTX 4070/PCIe/SSE2") && !softwareGl("Mesa Intel(R) Graphics (ADL GT2)") && !softwareGl("AMD Radeon Graphics (radeonsi, renoir)") && !softwareGl("");
    ::printf("where its windows are drawn without OpenGL: %s\n", softRight ? "as the table says" : "WRONG");
    return bad || !n || !flagsRight || !filesRight || !glRight || !softRight ? 1 : 0;
}

int main(int argc, char **argv)
{
    QString dir, appId = "io.github.agent_sh.Keel", test;
    bool devtools = false, probing = false, reader = false;
    for (int i = 1; i < argc; i++) {
        const QString a = QString::fromLocal8Bit(argv[i]);
        if (a == "--dir" && i + 1 < argc)
            dir = QString::fromLocal8Bit(argv[++i]);
        else if (a == "--app-id" && i + 1 < argc)
            appId = QString::fromLocal8Bit(argv[++i]);
        else if (a == "--self-test" && i + 1 < argc)
            test = QString::fromLocal8Bit(argv[++i]);
        else if (a == "--devtools")
            devtools = true;
        else if (a == "--probe")
            probing = true;
        else if (a == "--screen-reader")
            reader = true;
        else if (a == "--version") {
            ::printf("keel-desktop-qt %s (Qt %s)\n", KEEL_VERSION, qVersion());
            return 0;
        }
    }
    if (!test.isEmpty())
        return selfTest(test);
    if (dir.isEmpty()) {
        ::fprintf(stderr, "keel-desktop-qt: the windows of keel-desktop; it is started by the app, not by hand\n");
        return 2;
    }
    // The pipes to the app are this program's alone from here on (see `say`).
    appPipe = keepPrivate(STDOUT_FILENO, O_WRONLY);
    appIn = keepPrivate(STDIN_FILENO, O_RDONLY);

    // The engine's own accessibility tree is built for a screen reader, when the desktop says one
    // is on (the app reads that and passes it). Otherwise it is left off, as a browser leaves it:
    // with it, every row of the page is laid out, the ones out of view included, at every change,
    // which is most of what several long panes cost. The window's own controls stay accessible.
    if (!reader && !qEnvironmentVariableIsSet("QTWEBENGINE_ENABLE_LINUX_ACCESSIBILITY"))
        qputenv("QTWEBENGINE_ENABLE_LINUX_ACCESSIBILITY", "0");
    // What the environment the app was started in may not do to the engine without a word: open
    // its debugging port, or take its sandbox off. A developer asks for the inspector by name.
    QStringList dropped;
    QByteArray flags = qgetenv("QTWEBENGINE_CHROMIUM_FLAGS");
    if (!devtools) {
        for (const char *name : {"QTWEBENGINE_REMOTE_DEBUGGING", "QTWEBENGINE_DISABLE_SANDBOX"}) {
            if (qEnvironmentVariableIsSet(name)) {
                qunsetenv(name);
                dropped << name;
            }
        }
        flags = ownFlags(flags, &dropped);
        if (!dropped.isEmpty())
            ::fprintf(stderr, "keel-desktop-qt: not taken from the environment (start the app with --devtools for the inspector): %s\n", qPrintable(dropped.join(' ')));
    }
    if (!flags.contains("--js-flags"))
        flags += " --js-flags=--max-old-space-size=" + QByteArray::number(HEAP_MB) + ",--expose-gc";
    // A frame of content gets the keyboard by the owner's own act in it, never by asking: the
    // engine refuses a frame of another origin (a sandboxed one is) the focus it was not given.
    // Without this a frame that asks in a loop takes every key the owner types into the page.
    if (flags.contains("--enable-blink-features="))
        flags.replace("--enable-blink-features=", "--enable-blink-features=BlockingFocusWithoutUserActivation,");
    else
        flags += " --enable-blink-features=BlockingFocusWithoutUserActivation";
    // A local page has no use for calls between browsers: they find no address of this machine.
    flags += " --force-webrtc-ip-handling-policy=disable_non_proxied_udp";
    // The check's own mode (--probe): the engine's fake audio device stands in for a microphone, so the
    // permission path is proved on a machine that has none. The engine's own prompt stays: only the app answers.
    if (probing)
        flags += " --use-fake-device-for-media-stream";
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS", flags);

    QApplication::setDesktopFileName(appId);
    QApplication app(argc, argv);
    QApplication::setApplicationName("Keel");
    QApplication::setQuitOnLastWindowClosed(false);

    // The caret stands still. A blinking caret wakes the whole drawing path twice a second in a
    // window nobody is typing in (most of what an idle window with the message box in focus
    // costs), and the engine reads the blink once, as a page starts: it cannot be rested after
    // the owner's last key, as the desktop's own fields rest theirs. KEEL_DESKTOP_CARET_BLINK=1
    // keeps the desktop's blink.
    if (qgetenv("KEEL_DESKTOP_CARET_BLINK") != "1")
        QGuiApplication::styleHints()->setCursorFlashTime(0);
    // Under Wayland with a graphics driver the engine cannot share buffers with (it says so:
    // "GBM is not supported"), the engine draws its pages with Vulkan, and a window that is
    // itself drawn with OpenGL shows none of it: the page works and the window is black. There
    // the window is drawn with Vulkan too. (Before the first window; QSG_RHI_BACKEND or
    // QT_QUICK_BACKEND set by hand is left as it is.)
    const QString renderer = glRenderer();
    const bool chosen = qEnvironmentVariableIsSet("QSG_RHI_BACKEND") || qEnvironmentVariableIsSet("QT_QUICK_BACKEND");
    if (!chosen && vulkanWindow(QGuiApplication::platformName(), renderer))
        qputenv("QSG_RHI_BACKEND", "vulkan");
    else if (!chosen && softwareGl(renderer))
        qputenv("QT_QUICK_BACKEND", "software");
    const QByteArray draws = qEnvironmentVariableIsSet("QT_QUICK_BACKEND") ? qgetenv("QT_QUICK_BACKEND") : qEnvironmentVariableIsSet("QSG_RHI_BACKEND") ? qgetenv("QSG_RHI_BACKEND") : QByteArray("opengl");
    auto *profile = new QWebEngineProfile("keel", &app);
    profile->setPersistentStoragePath(dir + "/qt-web");
    profile->setCachePath(dir + "/qt-cache");
    profile->setHttpUserAgent(profile->httpUserAgent() + " Keel/" KEEL_VERSION);
    // A permission is never kept: each request is refused as it comes.
    profile->setPersistentPermissionsPolicy(QWebEngineProfile::PersistentPermissionsPolicy::AskEveryTime);
    profile->setUrlRequestInterceptor(new OwnFiles(profile));
    // This program runs and its engine is up: a display, the engine's own process, its profile.
    // The app waits for this line before it chooses this engine.
    say({{"t", "ready"}});
    say({{"t", "engine"}, {"qt", qVersion()}, {"chromium", qWebEngineChromiumVersion()}, {"patched", qWebEngineChromiumSecurityPatchVersion()},
         {"draws", QString::fromLatin1(draws)}, {"gl", renderer.left(60)}});

    Host host(profile, devtools, probing);
    const int code = app.exec();
    // The windows go before the profile their pages belong to.
    qDeleteAll(host.wins);
    qDeleteAll(host.spare);
    host.wins.clear();
    host.spare.clear();
    return code;
}

#include "main.moc"
