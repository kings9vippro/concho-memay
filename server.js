const express = require('express');
const fs = require('fs');
const path = require('path');
const { Zalo } = require('zca-js');

const app = express();
const PORT = process.env.PORT || 10000;

let isLoginSuccess = false;

// Khởi chạy tiến trình Zalo
async function startZalo() {
    // Xóa file qr.png cũ nếu có
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) {
        try { fs.unlinkSync(qrPath); } catch (e) {}
    }

    const zalo = new Zalo({ selfListen: false, checkUpdate: false });
    try {
        // Hàm này của thư viện sẽ tự tạo file qr.png trong máy chủ
        await zalo.loginQR();

        // Khi bạn ấn "Chấp nhận" trên điện thoại, dòng này mới được chạy
        isLoginSuccess = true;
        console.log("Xác nhận đăng nhập thành công từ điện thoại!");
    } catch (err) {
        console.error("Lỗi đăng nhập Zalo:", err.message);
    }
}

startZalo();

// Đường dẫn trả về file ảnh QR
app.get('/qr.png', (req, res) => {
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) {
        res.sendFile(qrPath);
    } else {
        res.status(404).send('Chưa có mã QR');
    }
});

// API kiểm tra trạng thái
app.get('/api/check-status', (req, res) => {
    const qrExists = fs.existsSync(path.join(__dirname, 'qr.png'));
    res.json({
        hasQR: qrExists,
        success: isLoginSuccess
    });
});

// Trang sau khi ấn chấp nhận thành công
app.get('/dashboard', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
            <h1 style="color: #28a745;">🎉 Đăng nhập Zalo thành công!</h1>
            <p>Thiết bị máy tính đã được cấp quyền truy cập.</p>
        </div>
    `);
});

// Giao diện chính
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Đăng nhập Zalo</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    display: flex; justify-content: center; align-items: center;
                    min-height: 100vh; margin: 0; background: #f0f2f5;
                }
                .box {
                    background: white; padding: 30px; border-radius: 12px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.1); text-align: center; width: 320px;
                }
                h2 { margin-top: 0; color: #0068ff; }
                .qr-box { width: 260px; height: 260px; margin: 15px auto; display: flex; align-items: center; justify-content: center; }
                img { width: 100%; border-radius: 8px; border: 1px solid #ddd; }
                #status { margin-top: 15px; font-weight: bold; color: #555; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="box">
                <h2>Zalo Login</h2>
                <div class="qr-box" id="qrArea">
                    <p>Đang tải mã QR...</p>
                </div>
                <div id="status">Vui lòng chờ...</div>
            </div>

            <script>
                let qrLoaded = false;
                const timer = setInterval(async () => {
                    try {
                        const res = await fetch('/api/check-status');
                        const data = await res.json();

                        // Khi phát hiện file qr.png đã được tạo trên server
                        if (data.hasQR && !qrLoaded && !data.success) {
                            qrLoaded = true;
                            // Load ảnh trực tiếp từ file qr.png
                            document.getElementById('qrArea').innerHTML = '<img src="/qr.png?t=' + Date.now() + '" alt="QR Zalo" />';
                            document.getElementById('status').innerText = 'Mở Zalo quét mã và bấm Chấp nhận trên điện thoại';
                        }

                        // Khi người dùng bấm Chấp nhận trên điện thoại
                        if (data.success) {
                            clearInterval(timer);
                            document.getElementById('status').innerText = 'Đăng nhập thành công! Đang chuyển trang...';
                            document.getElementById('status').style.color = 'green';
                            setTimeout(() => {
                                window.location.href = '/dashboard';
                            }, 1000);
                        }
                    } catch (e) {
                        console.log("Đang kiểm tra kết nối...");
                    }
                }, 1500);
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log("Server đang chạy ở port " + PORT);
});
