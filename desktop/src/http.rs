//! The little HTTP the shell speaks to the daemon on this machine: one request
//! per connection, and the event stream. Plain HTTP/1.1 over a loopback
//! socket; nothing here reaches another machine.
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub struct Resp {
    pub status: u16,
    pub body: String,
}

/// `http://host:port` -> `host:port`. A daemon behind TLS is not this machine's.
pub fn authority(base: &str) -> io::Result<&str> {
    let rest = base.strip_prefix("http://").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the shell reaches a daemon on this machine over http"))?;
    let host = rest.split('/').next().unwrap_or(rest);
    if host.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "no host in the daemon's address"));
    }
    Ok(host)
}

fn connect(base: &str, timeout: Duration) -> io::Result<TcpStream> {
    let host = authority(base)?;
    let with_port = if host.contains(':') && !host.ends_with(']') { host.to_string() } else { format!("{host}:80") };
    // Whatever the name says, the connection is made only to a loopback address it resolved to.
    let addrs: Vec<_> = with_port.to_socket_addrs()?.collect();
    if addrs.iter().any(|a| !a.ip().is_loopback()) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "the daemon's address is not this machine's"));
    }
    let addr = addrs.first().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the daemon's address does not resolve"))?;
    let s = TcpStream::connect_timeout(addr, timeout)?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    s.set_nodelay(true).ok();
    Ok(s)
}

fn head(method: &str, base: &str, path: &str, token: Option<&str>, extra: &str, len: Option<usize>) -> io::Result<String> {
    let mut h = format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nUser-Agent: keel-desktop/{}\r\n{extra}", authority(base)?, env!("CARGO_PKG_VERSION"));
    if let Some(t) = token {
        h.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(n) = len {
        h.push_str(&format!("Content-Type: application/json\r\nContent-Length: {n}\r\n"));
    }
    h.push_str("\r\n");
    Ok(h)
}

/// The status line and the headers, lower-cased names.
fn read_head(r: &mut impl BufRead) -> io::Result<(u16, Vec<(String, String)>)> {
    let mut line = String::new();
    r.read_line(&mut line)?;
    let status = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not an HTTP answer"))?;
    let mut headers = Vec::new();
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    Ok((status, headers))
}

fn header<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// One request, the whole answer.
pub fn request(base: &str, method: &str, path: &str, body: Option<&str>, token: Option<&str>, timeout: Duration) -> io::Result<Resp> {
    let mut s = connect(base, timeout)?;
    s.write_all(head(method, base, path, token, "Connection: close\r\nAccept: application/json\r\n", body.map(str::len))?.as_bytes())?;
    if let Some(b) = body {
        s.write_all(b.as_bytes())?;
    }
    let mut r = BufReader::new(s);
    let (status, headers) = read_head(&mut r)?;
    let mut raw = Vec::new();
    if header(&headers, "transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        Chunked::new(&mut r).read_to_end(&mut raw)?;
    } else if let Some(n) = header(&headers, "content-length").and_then(|v| v.parse::<usize>().ok()) {
        raw.resize(n.min(8 << 20), 0);
        r.read_exact(&mut raw)?;
    } else {
        r.read_to_end(&mut raw)?;
    }
    Ok(Resp { status, body: String::from_utf8_lossy(&raw).into_owned() })
}

/// A chunked body as plain bytes.
pub struct Chunked<R: BufRead> {
    inner: R,
    left: usize,
    done: bool,
}

impl<R: BufRead> Chunked<R> {
    pub fn new(inner: R) -> Self {
        Self { inner, left: 0, done: false }
    }
}

impl<R: BufRead> Read for Chunked<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done {
            return Ok(0);
        }
        if self.left == 0 {
            let mut line = String::new();
            // The line that ends the chunk before, then the size of this one.
            loop {
                line.clear();
                if self.inner.read_line(&mut line)? == 0 {
                    self.done = true;
                    return Ok(0);
                }
                if !line.trim().is_empty() {
                    break;
                }
            }
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("").trim(), 16).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a chunk without a size"))?;
            if size == 0 {
                self.done = true;
                return Ok(0);
            }
            self.left = size;
        }
        let want = buf.len().min(self.left);
        let n = self.inner.read(&mut buf[..want])?;
        if n == 0 {
            self.done = true;
        }
        self.left -= n;
        Ok(n)
    }
}

/// Server-sent events from lines: `on(event, data)` per event; `false` stops.
pub fn events(r: impl BufRead, mut on: impl FnMut(&str, &str) -> bool) -> io::Result<()> {
    let (mut event, mut data) = (String::new(), String::new());
    for line in r.lines() {
        let line = line?;
        if line.is_empty() {
            if !data.is_empty() || !event.is_empty() {
                if !on(if event.is_empty() { "message" } else { &event }, &data) {
                    return Ok(());
                }
                event.clear();
                data.clear();
            }
        } else if let Some(v) = line.strip_prefix("event:") {
            event = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(v.strip_prefix(' ').unwrap_or(v));
        }
    }
    Ok(())
}

/// The daemon's event stream until it ends. `quiet` is how long it may say
/// nothing (the daemon pings well inside it) before the stream counts as dead.
pub fn stream(base: &str, path: &str, token: Option<&str>, quiet: Duration, on: impl FnMut(&str, &str) -> bool) -> io::Result<()> {
    let mut s = connect(base, Duration::from_secs(3))?;
    s.set_read_timeout(Some(quiet))?;
    s.write_all(head("GET", base, path, token, "Accept: text/event-stream\r\nCache-Control: no-store\r\n", None)?.as_bytes())?;
    let mut r = BufReader::new(s);
    let (status, headers) = read_head(&mut r)?;
    if status != 200 {
        return Err(io::Error::new(io::ErrorKind::Other, format!("the daemon answered {status} to the shell's stream")));
    }
    if header(&headers, "transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        events(BufReader::new(Chunked::new(r)), on)
    } else {
        events(r, on)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn authority_of_a_local_address() {
        assert_eq!(authority("http://127.0.0.1:47960").unwrap(), "127.0.0.1:47960");
        assert_eq!(authority("http://localhost:1/x").unwrap(), "localhost:1");
        assert!(authority("https://example.com").is_err());
        assert!(authority("http://").is_err());
    }

    #[test]
    fn chunked_body_reads_as_bytes() {
        let raw = b"5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n";
        let mut out = String::new();
        Chunked::new(Cursor::new(&raw[..])).read_to_string(&mut out).unwrap();
        assert_eq!(out, "hello world");
    }

    #[test]
    fn chunked_body_cut_short_ends() {
        let raw = b"5\r\nhel";
        let mut out = Vec::new();
        Chunked::new(Cursor::new(&raw[..])).read_to_end(&mut out).unwrap();
        assert_eq!(out, b"hel");
    }

    #[test]
    fn events_are_told_one_by_one() {
        let text = ": keel\n\nevent: hello\ndata: {\"needs\":2}\n\n: ping\n\nevent: notify\ndata: {\"a\":1,\ndata: \"b\":2}\n\ndata: bare\n\n";
        let mut got = Vec::new();
        events(Cursor::new(text), |e, d| {
            got.push((e.to_string(), d.to_string()));
            true
        })
        .unwrap();
        assert_eq!(got, vec![("hello".into(), "{\"needs\":2}".into()), ("notify".into(), "{\"a\":1,\n\"b\":2}".into()), ("message".into(), "bare".into())]);
    }

    #[test]
    fn events_stop_when_asked() {
        let mut n = 0;
        events(Cursor::new("data: 1\n\ndata: 2\n\n"), |_, _| {
            n += 1;
            false
        })
        .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn head_is_read() {
        let mut r = Cursor::new("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nrest");
        let (status, h) = read_head(&mut r).unwrap();
        assert_eq!(status, 403);
        assert_eq!(header(&h, "transfer-encoding"), Some("chunked"));
    }
}
