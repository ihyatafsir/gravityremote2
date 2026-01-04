from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.request
import threading
import socketserver

target_url = "http://127.0.0.1:9090"

class ProxyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._proxy_request()

    def do_POST(self):
        self._proxy_request()

    def do_HEAD(self):
        self._proxy_request()

    def _proxy_request(self):
        try:
            url = target_url + self.path
            
            headers = dict(self.headers)
            headers['Host'] = 'localhost:9090'
            headers['Origin'] = 'http://localhost:9090'
            headers['Referer'] = 'http://localhost:9090/'

            req = urllib.request.Request(url, headers=headers, method=self.command)
            
            if 'Content-Length' in self.headers:
                req.data = self.rfile.read(int(self.headers['Content-Length']))

            with urllib.request.urlopen(req) as response:
                content = response.read()
                
                # --- MOBILE OPTIMIZATION INJECTION ---
                content_type = response.headers.get('Content-Type', '')
                if 'text/html' in content_type:
                    try:
                        html = content.decode('utf-8')
                        injection = """
                        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                        <style>
                            /* Mobile Optimization Injection */
                            @media only screen and (max-width: 600px) {
                                body, html { overflow-x: hidden !important; width: 100% !important; margin: 0 !important; }
                                * { max-width: 100% !important; box-sizing: border-box !important; }
                                .container, .main, #app { padding: 5px !important; width: 100% !important; }
                                p, span, div, a { font-size: 16px !important; line-height: 1.5 !important; }
                                input, textarea, button { font-size: 16px !important; min-height: 44px !important; }
                            }
                        </style>
                        """
                        if '</head>' in html:
                            html = html.replace('</head>', injection + '</head>')
                        else:
                            html = injection + html
                        content = html.encode('utf-8')
                    except:
                        pass 

                self.send_response(response.status)
                for k, v in response.headers.items():
                    if k.lower() not in ['content-encoding', 'transfer-encoding', 'content-length']:
                         self.send_header(k, v)
                
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())

class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    pass

def main():
    server = ThreadingHTTPServer(('0.0.0.0', 8890), ProxyHandler)
    print("HTTP Proxy running on 0.0.0.0:8890 -> Rewriting Host to localhost:9090")
    server.serve_forever()

if __name__ == "__main__":
    main()
