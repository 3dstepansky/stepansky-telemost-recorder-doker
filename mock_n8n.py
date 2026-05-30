import http.server
import socketserver
import json

class WebhookHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        print("\n[MOCK n8n] RECEIVED WEBHOOK:")
        try:
            payload = json.loads(post_data.decode('utf-8'))
            print(json.dumps(payload, indent=2, ensure_ascii=False))
            with open('webhook_received.json', 'w', encoding='utf-8') as f:
                json.dump(payload, f)
        except:
            print(post_data.decode('utf-8'))
        
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")

PORT = 5688
with socketserver.TCPServer(("", PORT), WebhookHandler) as httpd:
    print(f"[MOCK n8n] Listening on port {PORT}...")
    httpd.handle_request() # Ждем только один запрос
