const express = require('express');
const QRCode = require('qrcode');
const { Zalo } = require('zca-js');

const app = express();
const PORT = process.env.PORT || 3000;

let currentQRBase64 = null;
let isLoginSuccess = false;

// Hàm khởi tạo và lắng nghe Zalo
async function startZalo() {
    const zalo = new Zalo({ selfListen: false, checkUpdate: false });
    try {
        await zalo.loginQR({
            qrCallback: async (qrString) => {
                // Tạo ảnh QR khi Zalo cấp mã
                currentQRBase64 = await QRCode.toDataURL(qrString, { width: 260, margin: 2 });
                isLoginSuccess = false;
                console.log("Đã có mã QR mới.");
            }
        });

        // Chỉ chạy dòng này khi bạn bấm "Chấp nhận" trên điện thoại
        isLoginSuccess = true;
        console.log("Người dùng đã ấn Chấp nhận trên điện thoại!");

    } catch (err) {
        console.error("Lỗi phiên Zalo:", err.message);
    }
}

// Chạy tiến trình Zalo ngay khi bật server
startZalo();

// API để trình duyệt kiểm tra trạng thái mỗi 2 giây
app.get('/api/check-status', (req, res) => {
    res.json({
        qr: currentQRBase64,
        success: isLoginSuccess
    });
});

// Trang Dashboard sau khi đăng nhập
app.get('/dashboard', (req, res) => {
    res.send('<h1 style="text-align:center; color:green; margin-top:50px;">🎉 Đăng nhập Zalo thành công!</h1>');
});

// Giao diện chính hiển thị QR
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <title>Đăng nhập Zalo</title>
            <style>
                body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
                .box { background: white; padding: 30px; border-radius: 10px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 320px; }
                img { border: 1px solid #ddd; border-radius: 8px; width: 100%; }
                #status { margin-top: 15px; font-weight: bold; color: #555; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="box">
                <h2 style="color: #0068ff;">Zalo Login</h2>
                <div id="qrArea"><p>Đang tải mã QR...</p></div>
                <div id="status">Vui lòng chờ...</div>
            </div>

            <script>
                // Cứ mỗi 2 giây hỏi server 1 lần
                const timer = setInterval(async () => {
                    try {
                        const res = await fetch('/api/check-status');
                        const data = await res.json();

                        // Cập nhật ảnh QR nếu có
                        if (data.qr && !data.success) {
                            document.getElementById('qrArea').innerHTML = '<img src="' + data.qr + '" />';
                            document.getElementById('status').innerText = 'Dùng điện thoại quét mã và bấm Chấp nhận';
                        }

                        // Nếu server báo bạn đã bấm "Chấp nhận"
                        if (data.success) {
                            clearInterval(timer); // Dừng hỏi lặp
                            document.getElementById('status').innerText = 'Thành công! Đang chuyển trang...';
                            document.getElementById('status').style.color = 'green';
                            
                            // Tự động chuyển trang sau 1 giây
                            setTimeout(() => {
                                window.location.href = '/dashboard';
                            }, 1000);
                        }
                    } catch (e) {
                        console.log("Đang kết nối lại...");
                    }
                }, 2000);
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log("Server đang chạy ở port " + PORT);
});
