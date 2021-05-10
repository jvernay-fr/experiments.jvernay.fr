# experiments.jvernay.fr

This repository contain the sources for the website located at https://experiments.jvernay.fr/

The webserver is **nginx**.

In order to work, it requires the websocket server implemented in `backend/main.py`.
Its dependencies are a recent Python 3 installation and the package [websockets](https://websockets.readthedocs.io/).
Then, run the following command to run the server on port 1234.
```bash
python3 backend/main.py
```

The nginx configuration provided here is not complete and must be included from the main nginx.conf.
For instance, if this repository is cloned at `/path/to/experiments.jvernay.fr`, then the main nginx.conf will contain:

```nginx
http {
  server {
    listen 443 ssl;
    server_name experiments.jvernay.fr;
    
    root /path/to/experiments.jvernay.fr/root;
    include /path/to/experiments.jvernay.fr/nginx.conf;
  }
}
```
