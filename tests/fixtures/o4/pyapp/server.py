import argparse, http.server
a = argparse.ArgumentParser(); a.add_argument("--port", type=int); a.add_argument("--demo", action="store_true"); o = a.parse_args()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(s,*x): pass
    def do_GET(s):
        body = (b"<!doctype html><meta charset=utf-8><title>Py</title><h1>Demo data: " + (b"Sample Team" if o.demo else b"EMPTY") + b"</h1><button style='padding:14px'>Add game</button>")
        s.send_response(200); s.send_header("Content-Type","text/html"); s.end_headers(); s.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", o.port), H).serve_forever()
