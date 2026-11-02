import socket, json
try: socket.create_connection(("1.1.1.1", 80), 2); net = True
except OSError: net = False
json.dump({"net": net}, open("built.json", "w"))
