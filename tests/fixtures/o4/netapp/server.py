import http.server, os, socket
try: socket.create_connection(("1.1.1.1", 80), 2); NET = b"ONLINE"
except OSError: NET = b"offline"
class H(http.server.BaseHTTPRequestHandler):
    def log_message(s, *a): pass
    def do_GET(s):
        s.send_response(200); s.send_header("Content-Type", "text/html"); s.end_headers()
        s.wfile.write(b"<!doctype html><meta charset=utf-8><title>N</title><h1>" + NET + b"</h1><button style='padding:14px'>Add game</button>")
http.server.HTTPServer(("127.0.0.1", 4311), H).serve_forever()
