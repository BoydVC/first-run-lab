import os
R = os.path.dirname(os.path.abspath(__file__)); rd = lambda p: open(os.path.join(R, p)).read()
h = rd("web/index.html").replace("/*__CSS__*/", rd("web/app.css")).replace("/*__APP__*/", rd("web/app.js"))
os.makedirs(os.path.join(R, "dist"), exist_ok=True); open(os.path.join(R, "dist", "tplapp.html"), "w").write(h)
