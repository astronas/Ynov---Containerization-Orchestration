/* Simulateur, moteur Docker : images de base, conteneurs (processus rythmés par l'horloge virtuelle,
 * systèmes de fichiers en couches, volumes, bind mounts, tmpfs), réseaux avec DNS, serveurs HTTP,
 * gabarits --format à la Go, et la commande docker (hors build et images : voir sim-images.js). */
(function (G) {
  "use strict";
  const SIM = G.SIM; const O = SIM.outils; const R = SIM.R; const H = SIM.horloge; const chemin = SIM.chemin; const MSG = SIM.MSG;
  const D = (SIM.docker = {});

  /* ------------------------------------------------------------ gabarits Go */
  function valeurGo(v) {
    if (v === undefined) return "<no value>";
    if (v === null) return "<nil>";
    if (Array.isArray(v)) return "[" + v.map(valeurGo).join(" ") + "]";
    if (typeof v === "object") return "map[" + Object.keys(v).sort().map((k) => k + ":" + valeurGo(v[k])).join(" ") + "]";
    return String(v);
  }
  function gabarit(src, donnee) {
    src = src.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
    const toks = []; let i = 0;
    while (i < src.length) {
      const j = src.indexOf("{{", i);
      if (j < 0) { toks.push({ txt: src.slice(i) }); break; }
      if (j > i) toks.push({ txt: src.slice(i, j) });
      const k = src.indexOf("}}", j);
      if (k < 0) throw new Error("template: unclosed action");
      toks.push({ act: src.slice(j + 2, k).replace(/^-\s*/, "").replace(/\s*-$/, "").trim() });
      i = k + 2;
    }
    let p = 0;
    function bloc() {
      const nodes = [];
      while (p < toks.length) {
        const t = toks[p];
        if (t.act !== undefined) {
          if (t.act === "end" || t.act === "else") return nodes;
          const m = /^(range|if|with)\s+(.*)$/.exec(t.act);
          if (m) {
            p++; const corps = bloc(); let sinon = null;
            if (toks[p] && toks[p].act === "else") { p++; sinon = bloc(); }
            p++; nodes.push({ type: m[1], expr: m[2], corps, sinon }); continue;
          }
        }
        nodes.push(t); p++;
      }
      return nodes;
    }
    const arbre = bloc();
    const mots = (e) => { const out = []; const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g; let m; while ((m = re.exec(e))) out.push(m[1] !== undefined ? { lit: JSON.parse('"' + m[1] + '"') } : { w: m[2] }); return out; };
    function champ(w, dot) {
      if (w === ".") return dot;
      if (w.startsWith(".")) return w.slice(1).split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), dot);
      if (/^-?\d+$/.test(w)) return parseInt(w, 10);
      return w;
    }
    function evaluer(expr, dot) {
      const etapes = expr.split(/\s+\|\s+/);
      let v;
      etapes.forEach((e, k) => {
        const ws = mots(e); const val = (x) => (x.lit !== undefined ? x.lit : champ(x.w, dot));
        const f = ws[0].w; const args = ws.slice(1).map(val); if (k > 0) args.push(v);
        switch (f) {
          case "json": v = JSON.stringify(args[0] === undefined ? null : args[0]); break;
          case "index": v = args.slice(1).reduce((o, x) => (o == null ? undefined : o[x]), args[0]); if (v === undefined) v = ""; break;
          case "len": v = args[0] == null ? 0 : Array.isArray(args[0]) || typeof args[0] === "string" ? args[0].length : Object.keys(args[0]).length; break;
          case "join": v = (args[0] || []).join(args[1]); break;
          case "lower": v = String(args[0]).toLowerCase(); break;
          case "upper": v = String(args[0]).toUpperCase(); break;
          case "title": v = String(args[0]).replace(/\b\w/g, (c) => c.toUpperCase()); break;
          case "println": v = args.map(valeurGo).join(" ") + "\n"; break;
          case "print": v = args.map(valeurGo).join(""); break;
          case "printf": { let n = 1; v = String(args[0]).replace(/%[sdvq]/g, (c) => (c === "%q" ? JSON.stringify(String(args[n++])) : valeurGo(args[n++]))); break; }
          default: v = ws.length === 1 && k === 0 ? val(ws[0]) : val(ws[0]);
        }
      });
      return v;
    }
    const vrai = (v) => !(v === undefined || v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length));
    function rendre(nodes, dot) {
      let out = "";
      for (const n of nodes) {
        if (n.txt !== undefined) { out += n.txt; continue; }
        if (n.type === "range") {
          const v = evaluer(n.expr, dot);
          const elems = v == null ? [] : Array.isArray(v) ? v : typeof v === "object" ? Object.keys(v).sort().map((k) => v[k]) : [];
          if (!elems.length && n.sinon) out += rendre(n.sinon, dot);
          elems.forEach((e) => { out += rendre(n.corps, e); });
          continue;
        }
        if (n.type === "if" || n.type === "with") {
          const v = evaluer(n.expr, dot);
          if (vrai(v)) out += rendre(n.corps, n.type === "with" ? v : dot); else if (n.sinon) out += rendre(n.sinon, dot);
          continue;
        }
        out += valeurGo(evaluer(n.act, dot));
      }
      return out;
    }
    return rendre(arbre, donnee);
  }
  D.gabarit = gabarit;
  const ENTETES = { ID: "CONTAINER ID", Image: "IMAGE", Command: "COMMAND", CreatedAt: "CREATED AT", RunningFor: "CREATED", Ports: "PORTS",
    Status: "STATUS", Size: "SIZE", Names: "NAMES", Labels: "LABELS", Mounts: "MOUNTS", Networks: "NETWORKS", State: "STATE", Service: "SERVICE",
    Name: "NAME", Project: "PROJECT", Repository: "REPOSITORY", Tag: "TAG", CreatedSince: "CREATED", CreatedBy: "CREATED BY", Comment: "COMMENT",
    Digest: "DIGEST", Container: "CONTAINER", CPUPerc: "CPU %", MemUsage: "MEM USAGE / LIMIT", MemPerc: "MEM %", NetIO: "NET I/O", BlockIO: "BLOCK I/O",
    PIDs: "PIDS", Driver: "DRIVER", Scope: "SCOPE", Publishers: "PUBLISHERS", Health: "HEALTH", ExitCode: "EXIT CODE" };
  // --format : gabarit sur chaque objet, avec « table » pour l'en-tête et l'alignement.
  D.formater = function (format, objets, entetes = {}) {
    let g = format;
    const table = /^table(\s+|$)/.test(g);
    if (table) g = g.replace(/^table\s*/, "");
    try {
      const lignes = objets.map((o) => gabarit(g, o));
      if (!table) return R.ok(lignes.flatMap((l) => l.split("\n")));
      const tete = g.replace(/\\t/g, "\t").replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, k) => entetes[k] || ENTETES[k] || k.toUpperCase());
      return R.ok(O.tableau([tete].concat(lignes).map((l) => l.split("\t")), 3, 10));
    } catch (e) { return R.err(`template parsing error: ${e.message}`, 1); }
  };

  /* ---------------------------------------------------------- utilitaires */
  function hacher(s) { let h1 = 0x811c9dc5, h2 = 0x1234567; for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619); h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519); } return h1 >>> 0 ^ (h2 >>> 3); }
  D.hexDe = (graine, n = 64) => { let out = ""; let k = 0; while (out.length < n) out += (hacher(graine + ":" + k++) >>> 0).toString(16).padStart(8, "0"); return out.slice(0, n); };
  D.dureeMs = (v) => { let ms = 0; const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g; let m; while ((m = re.exec(String(v)))) ms += parseFloat(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]; return ms || (/^\d+$/.test(v) ? parseInt(v, 10) * 1e9 / 1e6 : 0); };
  // Découpe un script sh en instructions de premier niveau (; && || et retours à la ligne).
  D.instructions = function (script) {
    const out = []; let cur = ""; let q = null; let prof = 0;
    for (let i = 0; i < script.length; i++) {
      const c = script[i];
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; continue; }
      if (c === "(") prof++; if (c === ")") prof--;
      if (!prof && (c === ";" || c === "\n" || (c === "&" && script[i + 1] === "&"))) { if (cur.trim()) out.push(cur.trim()); cur = ""; if (c === "&") i++; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };

  /* --------------------------------------------------- systèmes de base */
  const PATH = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const ALPINE_PASSWD = "root:x:0:0:root:/root:/bin/sh\nbin:x:1:1:bin:/bin:/sbin/nologin\ndaemon:x:2:2:daemon:/sbin:/sbin/nologin\nlp:x:4:7:lp:/var/spool/lpd:/sbin/nologin\nsync:x:5:0:sync:/sbin:/bin/sync\nshutdown:x:6:0:shutdown:/sbin:/sbin/shutdown\nhalt:x:7:0:halt:/sbin:/sbin/halt\nmail:x:8:12:mail:/var/mail:/sbin/nologin\nnews:x:9:13:news:/usr/lib/news:/sbin/nologin\nuucp:x:10:14:uucp:/var/spool/uucppublic:/sbin/nologin\ncron:x:16:16:cron:/var/spool/cron:/sbin/nologin\nftp:x:21:21::/var/lib/ftp:/sbin/nologin\nsshd:x:22:22:sshd:/dev/null:/sbin/nologin\ngames:x:35:35:games:/usr/games:/sbin/nologin\nntp:x:123:123:NTP:/var/empty:/sbin/nologin\nguest:x:405:100:guest:/dev/null:/sbin/nologin\nnobody:x:65534:65534:nobody:/:/sbin/nologin\n";
  const ALPINE_GROUP = "root:x:0:root\nbin:x:1:root,bin,daemon\ndaemon:x:2:root,bin,daemon\nsys:x:3:root,bin\nadm:x:4:root,daemon\ntty:x:5:\ndisk:x:6:root\nlp:x:7:lp\nkmem:x:9:\nwheel:x:10:root\nfloppy:x:11:root\nmail:x:12:mail\nnews:x:13:news\nuucp:x:14:uucp\ncron:x:16:cron\naudio:x:18:\ncdrom:x:19:\ndialout:x:20:root\nftp:x:21:\nsshd:x:22:\ninput:x:23:\ntape:x:26:root\nvideo:x:27:root\nnetdev:x:28:\nkvm:x:34:kvm\ngames:x:35:\nshadow:x:42:\nwww-data:x:82:\nusers:x:100:games\nntp:x:123:\nabuild:x:300:\nutmp:x:406:\nping:x:999:\nnogroup:x:65533:\nnobody:x:65534:\n";
  const DEBIAN_PASSWD = "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nbin:x:2:2:bin:/bin:/usr/sbin/nologin\nsys:x:3:3:sys:/dev:/usr/sbin/nologin\nsync:x:4:65534:sync:/bin:/bin/sync\ngames:x:5:60:games:/usr/games:/usr/sbin/nologin\nman:x:6:12:man:/var/cache/man:/usr/sbin/nologin\nlp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin\nmail:x:8:8:mail:/var/mail:/usr/sbin/nologin\nnews:x:9:9:news:/var/spool/news:/usr/sbin/nologin\nuucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin\nproxy:x:13:13:proxy:/bin:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\nbackup:x:34:34:backup:/var/backups:/usr/sbin/nologin\nlist:x:38:38:Mailing List Manager:/var/list:/usr/sbin/nologin\nirc:x:39:39:ircd:/run/ircd:/usr/sbin/nologin\n_apt:x:42:65534::/nonexistent:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n";
  const DEBIAN_GROUP = "root:x:0:\ndaemon:x:1:\nbin:x:2:\nsys:x:3:\nadm:x:4:\ntty:x:5:\ndisk:x:6:\nlp:x:7:\nmail:x:8:\nnews:x:9:\nuucp:x:10:\nman:x:12:\nproxy:x:13:\nkmem:x:15:\ndialout:x:20:\nfax:x:21:\nvoice:x:22:\ncdrom:x:24:\nfloppy:x:25:\ntape:x:26:\nsudo:x:27:\naudio:x:29:\ndip:x:30:\nwww-data:x:33:\nbackup:x:34:\noperator:x:37:\nlist:x:38:\nirc:x:39:\nsrc:x:40:\nshadow:x:42:\nutmp:x:43:\nvideo:x:44:\nsasl:x:45:\nplugdev:x:46:\nstaff:x:50:\ngames:x:60:\nusers:x:100:\nnogroup:x:65534:\n";
  const OS = {
    alpine: 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.22.2\nPRETTY_NAME="Alpine Linux v3.22"\nHOME_URL="https://alpinelinux.org/"\nBUG_REPORT_URL="https://gitlab.alpinelinux.org/alpine/aports/-/issues"\n',
    alpine324: 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.24.3\nPRETTY_NAME="Alpine Linux v3.24"\nHOME_URL="https://alpinelinux.org/"\nBUG_REPORT_URL="https://gitlab.alpinelinux.org/alpine/aports/-/issues"\n',
    busybox: 'NAME="BusyBox"\nPRETTY_NAME="BusyBox v1.37.0"\n',
    debian: 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION="13 (trixie)"\nVERSION_CODENAME=trixie\nID=debian\nHOME_URL="https://www.debian.org/"\n',
    ubuntu: 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.3 LTS (Noble Numbat)"\nID=ubuntu\nID_LIKE=debian\n',
  };
  const NGINX_HTML = "<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n<style>\nhtml { color-scheme: light dark; }\nbody { width: 35em; margin: 0 auto;\nfont-family: Tahoma, Verdana, Arial, sans-serif; }\n</style>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, nginx is successfully installed and working.\nFurther configuration is required for the web server, reverse proxy, \nAPI gateway, load balancer, content cache, or other features.</p>\n\n<p>For online documentation and support please refer to\n<a href=\"https://nginx.org/\">nginx.org</a>.<br/>\nTo engage with the community please visit\n<a href=\"https://community.nginx.org/\">community.nginx.org</a>.<br/>\nFor enterprise grade support, professional services, additional \nsecurity features and capabilities please refer to\n<a href=\"https://f5.com/nginx\">f5.com/nginx</a>.</p>\n\n<p><em>Thank you for using nginx.</em></p>\n</body>\n</html>\n";
  const HTTPD_HTML = "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 4.01//EN\" \"http://www.w3.org/TR/html4/strict.dtd\">\n<html>\n<head>\n<title>It works! Apache httpd</title>\n</head>\n<body>\n<p>It works!</p>\n</body>\n</html>\n";
  const HELLO = "\nHello from Docker!\nThis message shows that your installation appears to be working correctly.\n\nTo generate this message, Docker took the following steps:\n 1. The Docker client contacted the Docker daemon.\n 2. The Docker daemon pulled the \"hello-world\" image from the Docker Hub.\n    (amd64)\n 3. The Docker daemon created a new container from that image which runs the\n    executable that produces the output you are currently reading.\n 4. The Docker daemon streamed that output to the Docker client, which sent it\n    to your terminal.\n\nTo try something more ambitious, you can run an Ubuntu container with:\n $ docker run -it ubuntu bash\n\nShare images, automate workflows, and more with a free Docker ID:\n https://hub.docker.com/\n\nFor more examples and ideas, visit:\n https://docs.docker.com/get-started/\n";
  D.textes = { NGINX_HTML, HTTPD_HTML, HELLO };

  function fsBase(famille, extra = {}) {
    const m = new Map(); const t = H.now() - 20 * 86400000;
    const dir = (p, mode = 0o755, uid = 0) => m.set(p, { type: "d", uid, gid: uid, mode, mtime: t });
    const fic = (p, contenu, o = {}) => m.set(p, { type: "f", contenu, uid: o.uid || 0, gid: o.gid || o.uid || 0, mode: o.mode || 0o644, mtime: t, taille: o.taille });
    dir("/");
    ["/bin", "/dev", "/etc", "/home", "/lib", "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/usr/bin", "/usr/lib", "/usr/local", "/usr/local/bin", "/usr/share", "/var", "/var/cache", "/var/lib", "/var/log", "/var/run"].forEach((p) => dir(p, p === "/root" ? 0o700 : 0o755));
    dir("/tmp", 0o1777);
    if (famille === "busybox") { fic("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\ndaemon:x:1:1:daemon:/usr/sbin:/bin/false\nbin:x:2:2:bin:/bin:/bin/false\nsys:x:3:3:sys:/dev:/bin/false\nsync:x:4:100:sync:/bin:/bin/sync\nmail:x:8:8:mail:/var/spool/mail:/bin/false\nwww-data:x:33:33:www-data:/var/www:/bin/false\noperator:x:37:37:Operator:/var:/bin/false\nnobody:x:65534:65534:nobody:/home:/bin/false\n"); fic("/etc/group", "root:x:0:\ndaemon:x:1:\nbin:x:2:\nsys:x:3:\nadm:x:4:\ntty:x:5:\ndisk:x:6:\nwheel:x:10:root\nwww-data:x:33:\nusers:x:100:\nnogroup:x:65534:\n"); fic("/etc/os-release", OS.busybox); }
    else if (famille === "alpine" || famille === "alpine324") { fic("/etc/passwd", ALPINE_PASSWD); fic("/etc/group", ALPINE_GROUP); fic("/etc/os-release", OS[famille]); fic("/etc/alpine-release", famille === "alpine" ? "3.22.2\n" : "3.24.3\n"); }
    else { fic("/etc/passwd", DEBIAN_PASSWD + (extra.passwd || "")); fic("/etc/group", DEBIAN_GROUP + (extra.group || "")); fic("/etc/os-release", OS[famille] || OS.debian); }
    for (const [p, v] of Object.entries(extra.dossiers || {})) dir(p, v.mode || 0o755, v.uid || 0);
    for (const [p, v] of Object.entries(extra.fichiers || {})) { let q = chemin.parent(p); const manquants = []; while (!m.has(q)) { manquants.unshift(q); q = chemin.parent(q); } manquants.forEach((d) => dir(d)); fic(p, v); }
    return m;
  }

  // Images connues du « Docker Hub » simulé. id : les 12 premiers caractères réels quand on les connaît.
  const BASES = {
    "alpine": { tags: { "3.22": "2e0b81d60597", latest: "2e0b81d60597", "3.21": "4bcff63911fc" }, famille: "alpine", variante: "sh", disque: 12.9e6, contenu: 3.88e6, cmd: ["/bin/sh"], couches: 1 },
    "busybox": { tags: { "1.37": "bdf57e528e45", latest: "bdf57e528e45" }, famille: "busybox", variante: "sh", disque: 6.77e6, contenu: 2.22e6, cmd: ["sh"], couches: 1 },
    "hello-world": { tags: { latest: "11a3eb1597e8" }, famille: "scratch", variante: "sh", disque: 25.9e3, contenu: 9.49e3, cmd: ["/hello"], couches: 1, programme: "hello" },
    "nginx": { tags: { stable: "a7675fcee220", latest: "b1d2e1c8f5a4", "1.25": "6c8e2f1a9b3d", "1.27": "c3a1f0b7d2e9", "1.28": "d4b2a1c0e8f7", alpine: "e5c3b2a1d0f9" }, famille: "debian", variante: "dash", disque: 242e6, contenu: 66.5e6,
      entrypoint: ["/docker-entrypoint.sh"], cmd: ["nginx", "-g", "daemon off;"], env: ["NGINX_VERSION=1.30.6", "NJS_VERSION=0.9.4", "NJS_RELEASE=1~trixie", "PKG_RELEASE=1~trixie", "DYNPKG_RELEASE=1~trixie"],
      expose: ["80/tcp"], couches: 7, programme: "nginx", stop: "SIGQUIT", arret: 400,
      extra: { passwd: "nginx:x:101:101:nginx user:/nonexistent:/bin/false\n", group: "nginx:x:101:\n", dossiers: { "/var/cache/nginx": {}, "/usr/share/nginx/html": {}, "/etc/nginx/conf.d": {}, "/docker-entrypoint.d": {} },
        fichiers: { "/usr/share/nginx/html/index.html": NGINX_HTML, "/usr/share/nginx/html/50x.html": "<!DOCTYPE html>\n<html>\n<head>\n<title>Error</title>\n</head>\n<body>\n<h1>An error occurred.</h1>\n</body>\n</html>\n", "/etc/nginx/nginx.conf": "user  nginx;\nworker_processes  auto;\n\nerror_log  /var/log/nginx/error.log notice;\npid        /run/nginx.pid;\n\nevents {\n    worker_connections  1024;\n}\n\nhttp {\n    include       /etc/nginx/mime.types;\n    default_type  application/octet-stream;\n    sendfile        on;\n    keepalive_timeout  65;\n    include /etc/nginx/conf.d/*.conf;\n}\n", "/etc/nginx/conf.d/default.conf": "server {\n    listen       80;\n    listen  [::]:80;\n    server_name  localhost;\n\n    location / {\n        root   /usr/share/nginx/html;\n        index  index.html index.htm;\n    }\n\n    error_page   500 502 503 504  /50x.html;\n    location = /50x.html {\n        root   /usr/share/nginx/html;\n    }\n}\n", "/docker-entrypoint.sh": "#!/bin/sh\n" } } },
    "httpd": { tags: { "2.4": "a30cd4cd57f3", latest: "a30cd4cd57f3" }, famille: "debian", variante: "dash", disque: 177e6, contenu: 47.7e6, cmd: ["httpd-foreground"], env: ["HTTPD_PREFIX=/usr/local/apache2", "HTTPD_VERSION=2.4.69"],
      workdir: "/usr/local/apache2", expose: ["80/tcp"], couches: 5, programme: "httpd", stop: "SIGWINCH", arret: 1100,
      extra: { fichiers: { "/usr/local/apache2/htdocs/index.html": HTTPD_HTML, "/usr/local/apache2/conf/httpd.conf": "ServerRoot \"/usr/local/apache2\"\nListen 80\nUser www-data\nGroup www-data\n" } } },
    "php": { tags: { "8.4-apache": "c6527b06c772" }, famille: "debian", variante: "dash", disque: 729e6, contenu: 187e6, entrypoint: ["docker-php-entrypoint"], cmd: ["apache2-foreground"],
      env: ["PHPIZE_DEPS=autoconf dpkg-dev file g++ gcc libc-dev make pkg-config re2c", "PHP_INI_DIR=/usr/local/etc/php", "APACHE_CONFDIR=/etc/apache2", "APACHE_ENVVARS=/etc/apache2/envvars", "PHP_VERSION=8.4.27"],
      workdir: "/var/www/html", expose: ["80/tcp"], couches: 13, programme: "apache", stop: "SIGWINCH", arret: 1200, extra: { dossiers: { "/var/www/html": { uid: 33 } } } },
    "python": { tags: { "3.12-alpine": "5789aa194f75", "3.12": "f1e2d3c4b5a6", latest: "a9b8c7d6e5f4" }, famille: "alpine324", variante: "sh", disque: 74.7e6, contenu: 18.7e6, cmd: ["python3"],
      env: ["LANG=C.UTF-8", "GPG_KEY=7169605F62C751356D054A26A821E680E5FA6305", "PYTHON_VERSION=3.12.16", "PYTHON_SHA256=b5796915dc45ff745cfb4e990a5c4e2f8d8b0e5c0a1d0a8f3e2b9c4d5e6f7a8b"],
      couches: 4, digest: "5789aa194f757888f41fa3d48e14b6feaa1b57c0af0b56fcb1372d6474d3bff0", programme: "python",
      historique: [["CMD [\"python3\"]", "0B"], ["RUN /bin/sh -c set -eux;  for src in idle3 p…", "16.4kB"], ["RUN /bin/sh -c set -eux;   apk add --no-cach…", "44.1MB"], ["ENV PYTHON_SHA256=b5796915dc45ff745cfb4e990a…", "0B"], ["ENV PYTHON_VERSION=3.12.16", "0B"], ["ENV GPG_KEY=7169605F62C751356D054A26A821E680…", "0B"], ["RUN /bin/sh -c set -eux;  apk add --no-cache…", "2.81MB"], ["ENV LANG=C.UTF-8", "0B"], ["ENV PATH=/usr/local/bin:/usr/local/sbin:/usr…", "0B"], ["CMD [\"/bin/sh\"]", "0B"], ["ADD alpine-minirootfs-3.24.3-x86_64.tar.gz /…", "9.08MB"]] },
    "registry": { tags: { "2": "a3d8aaa63ed8" }, famille: "alpine", variante: "sh", disque: 37.4e6, contenu: 10.3e6, entrypoint: ["/entrypoint.sh"], cmd: ["/etc/distribution/config.yml"],
      expose: ["5000/tcp"], volumes: ["/var/lib/registry"], couches: 5, programme: "registry", stop: "SIGTERM", arret: 300 },
    "mariadb": { tags: { "11.4": "d1891ede5a55", latest: "d1891ede5a55" }, famille: "ubuntu", variante: "dash", disque: 455e6, contenu: 108e6, entrypoint: ["docker-entrypoint.sh"], cmd: ["mariadbd"],
      env: ["GOSU_VERSION=1.17", "LANG=C.UTF-8", "MARIADB_VERSION=1:11.4.8+maria~ubu2404"], expose: ["3306/tcp"], volumes: ["/var/lib/mysql"], couches: 8, programme: "mariadb", stop: "SIGTERM", arret: 2200,
      extra: { passwd: "mysql:x:999:999::/home/mysql:/bin/sh\n", group: "mysql:x:999:\n" } },
    "postgres": { tags: { "15": "f5a2b6c3d8e1", latest: "a1c2e3f4b5d6" }, famille: "debian", variante: "dash", disque: 438e6, contenu: 151e6, entrypoint: ["docker-entrypoint.sh"], cmd: ["postgres"],
      env: ["GOSU_VERSION=1.17", "LANG=en_US.utf8", "PG_MAJOR=15", "PG_VERSION=15.14-1.pgdg13+1", "PGDATA=/var/lib/postgresql/data"], expose: ["5432/tcp"], volumes: ["/var/lib/postgresql/data"], couches: 14, programme: "postgres", stop: "SIGINT", arret: 600,
      extra: { passwd: "postgres:x:999:999::/var/lib/postgresql:/bin/bash\n", group: "postgres:x:999:\n" } },
    "gcr.io/k8s-minikube/kicbase": { tags: { "v0.0.51": "4b7f1c2d3e9a" }, famille: "ubuntu", variante: "dash", disque: 1.38e9, contenu: 501e6, entrypoint: ["/usr/local/bin/entrypoint"], cmd: ["/sbin/init"], couches: 22, programme: "kic", stop: "SIGRTMIN+3", arret: 3000 },
    "aquasec/trivy": { tags: { "0.58.1": "8f1e0d2c3b4a", latest: "8f1e0d2c3b4a" }, famille: "alpine", variante: "sh", disque: 172e6, contenu: 48.6e6, entrypoint: ["trivy"], cmd: [], couches: 4, programme: "trivy" },
  };
  D.BASES = BASES;

  /* --------------------------------------------- système de fichiers en couches */
  // couches : listes de Map(chemin -> nœud | {wh: true}) de bas en haut ; upper : la couche inscriptible.
  class FSConteneur {
    constructor(o) {
      this.couches = o.couches; this.upper = o.upper || new Map(); this.montages = (o.montages || []).slice().sort((a, b) => b.dest.length - a.dest.length);
      this.ro = !!o.ro; this.virtuels = o.virtuels || null; this.uid = 0;
    }
    resoudre(p) {
      for (const m of this.montages) {
        if (p === m.dest) return { m, q: m.src };
        if (p.startsWith(m.dest === "/" ? "/" : m.dest + "/")) return { m, q: chemin.norm((m.src === "/" ? "" : m.src) + "/" + p.slice(m.dest.length + 1)) };
      }
      return null;
    }
    bas(p) { for (let k = this.couches.length - 1; k >= 0; k--) { const v = this.couches[k].get(p); if (v !== undefined) return v.wh ? null : v; } return null; }
    stat(p) {
      if (this.virtuels) { const v = this.virtuels(p); if (v) return v; }
      const r = this.resoudre(p);
      if (r) return r.m.fs.stat(r.q);
      if (this.upper.has(p)) { const v = this.upper.get(p); return v.wh ? null : v; }
      return this.bas(p);
    }
    taille(n) { return n.type === "d" ? 4096 : n.taille !== undefined ? n.taille : O.octets(n.contenu || ""); }
    lire(p) { const n = this.stat(p); if (!n) return { err: "ENOENT" }; if (n.type === "d") return { err: "EISDIR" }; return { node: n, contenu: typeof n.contenu === "function" ? n.contenu() : n.contenu || "" }; }
    ecrire(p, contenu, o = {}) {
      const r = this.resoudre(p);
      if (r) { if (r.m.ro) return "EROFS"; return r.m.fs.ecrire(r.q, contenu, o); }
      if (this.ro) return "EROFS";
      const par = this.stat(chemin.parent(p));
      if (!par) return "ENOENT";
      if (par.type !== "d") return "ENOTDIR";
      const ex = this.stat(p);
      if (ex && ex.type === "d") return "EISDIR";
      if (ex && ex.virtuel) return "EACCES";
      const n = ex && o.ajout ? { ...ex, contenu: (ex.contenu || "") + contenu, taille: undefined } : { type: "f", contenu, uid: o.uid ?? (ex ? ex.uid : this.uid), gid: o.gid ?? (ex ? ex.gid : this.uid), mode: o.mode ?? (ex ? ex.mode : 0o644) };
      if (o.taille !== undefined) n.taille = o.taille;
      if (o.archive) n.archive = o.archive;
      n.mtime = H.now();
      this.upper.set(p, n);
      return null;
    }
    mkdir(p, o = {}) {
      if (p === "/") return o.parents ? null : "EEXIST";
      const r = this.resoudre(p);
      if (r && p !== r.m.dest) { if (r.m.ro) return "EROFS"; return r.m.fs.mkdir(r.q, o); }
      const ex = this.stat(p);
      if (ex) return o.parents && ex.type === "d" ? null : "EEXIST";
      if (this.ro) return "EROFS";
      const par = chemin.parent(p);
      if (!this.stat(par)) { if (!o.parents) return "ENOENT"; const e = this.mkdir(par, o); if (e) return e; }
      this.upper.set(p, { type: "d", uid: o.uid ?? this.uid, gid: o.gid ?? this.uid, mode: o.mode ?? 0o755, mtime: H.now() });
      return null;
    }
    tous(p) {
      // Chemins visibles sous p (hors montages).
      const pre = p === "/" ? "/" : p + "/"; const vus = new Set();
      [...this.couches, this.upper].forEach((c) => { for (const k of c.keys()) if (k.startsWith(pre)) vus.add(k); });
      return [...vus].filter((k) => this.stat(k)).sort();
    }
    rm(p, o = {}) {
      const r = this.resoudre(p);
      if (r) { if (p === r.m.dest) return "EBUSY"; if (r.m.ro) return "EROFS"; return r.m.fs.rm(r.q, o); }
      const n = this.stat(p);
      if (!n) return "ENOENT";
      if (this.ro) return "EROFS";
      if (n.type === "d") {
        const enfants = this.tous(p);
        if (!o.recursif && !o.dossier) return "EISDIR";
        if (!o.recursif && enfants.length) return "ENOTEMPTY";
        enfants.forEach((k) => (this.bas(k) ? this.upper.set(k, { wh: true }) : this.upper.delete(k)));
      }
      if (this.bas(p)) this.upper.set(p, { wh: true }); else this.upper.delete(p);
      return null;
    }
    lister(p) {
      const r = this.resoudre(p);
      if (r) return r.m.fs.lister(r.q);
      const n = this.stat(p);
      if (!n) return { err: "ENOENT" };
      if (n.type !== "d") return { noms: [chemin.base(p)], fichier: true };
      const pre = p === "/" ? "/" : p + "/"; const noms = new Set();
      [...this.couches, this.upper].forEach((c) => { for (const k of c.keys()) if (k.startsWith(pre) && !k.slice(pre.length).includes("/") && this.stat(k)) noms.add(k.slice(pre.length)); });
      this.montages.forEach((m) => { if (m.dest.startsWith(pre) && !m.dest.slice(pre.length).includes("/")) noms.add(m.dest.slice(pre.length)); });
      if (p === "/proc" && this.procs) this.procs().forEach((x) => noms.add(String(x)));
      return { noms: [...noms].sort() };
    }
    parcourir(p) {
      const n = this.stat(p);
      if (!n) return [];
      if (n.type !== "d") return [{ p, node: n }];
      return [{ p, node: n }].concat(this.tous(p).map((k) => ({ p: k, node: this.stat(k) })));
    }
    // Changements de la couche inscriptible (docker diff).
    diff() {
      const lignes = new Map();
      for (const [k, v] of this.upper) {
        if (v.wh) { if (this.bas(k)) lignes.set(k, "D"); continue; }
        lignes.set(k, this.bas(k) ? (v.type === "d" ? "C" : "C") : "A");
        let q = chemin.parent(k);
        while (q !== "/") { if (!lignes.has(q) && this.bas(q)) lignes.set(q, "C"); q = chemin.parent(q); }
      }
      return [...lignes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, t]) => `${t} ${k}`);
    }
  }
  D.FSConteneur = FSConteneur;

  /* --------------------------------------------------------- capabilities */
  const CAPS = ["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "LINUX_IMMUTABLE",
    "NET_BIND_SERVICE", "NET_BROADCAST", "NET_ADMIN", "NET_RAW", "IPC_LOCK", "IPC_OWNER", "SYS_MODULE", "SYS_RAWIO", "SYS_CHROOT", "SYS_PTRACE",
    "SYS_PACCT", "SYS_ADMIN", "SYS_BOOT", "SYS_NICE", "SYS_RESOURCE", "SYS_TIME", "SYS_TTY_CONFIG", "MKNOD", "LEASE", "AUDIT_WRITE", "AUDIT_CONTROL",
    "SETFCAP", "MAC_OVERRIDE", "MAC_ADMIN", "SYSLOG", "WAKE_ALARM", "BLOCK_SUSPEND", "AUDIT_READ", "PERFMON", "BPF", "CHECKPOINT_RESTORE"];
  const DEFAUT = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "NET_BIND_SERVICE", "NET_RAW", "SYS_CHROOT", "MKNOD", "AUDIT_WRITE", "SETFCAP"];
  D.CAPS = CAPS;
  const nomCap = (c) => c.toUpperCase().replace(/^CAP_/, "");
  function capsEffectives(c) {
    let s = new Set(c.hostConfig.Privileged ? CAPS : DEFAUT);
    (c.hostConfig.CapDrop || []).forEach((x) => { if (nomCap(x) === "ALL") s.clear(); else s.delete(nomCap(x)); });
    (c.hostConfig.CapAdd || []).forEach((x) => { if (nomCap(x) === "ALL") CAPS.forEach((k) => s.add(k)); else s.add(nomCap(x)); });
    return s;
  }
  const masque = (s) => { let v = 0n; s.forEach((k) => { const b = CAPS.indexOf(k); if (b >= 0) v |= 1n << BigInt(b); }); return v.toString(16).padStart(16, "0"); };
  D.capsEffectives = capsEffectives; D.masque = masque;

  /* ------------------------------------------------------------- le moteur */
  let courant = null;
  SIM.surTic((t) => { if (courant) courant.avancerTout(t); });

  class Moteur {
    constructor(hote, o = {}) { this.hote = hote; this.secondaire = !!o.secondaire; this.reinitialiser(); if (!this.secondaire) courant = this; }
    reinitialiser() {
      this.images = new Map();     // référence -> image
      this.conteneurs = [];
      this.volumes = {};
      this.reseaux = {};
      this.cacheBuild = new Map();
      this.prochainSousReseau = 23;
      this.pidHote = 258000 + Math.floor(Math.random() * 20000);
      this.creerReseau("bridge", { driver: "bridge", sousReseau: "172.17.0", defaut: true });
      this.creerReseau("host", { driver: "host" });
      this.creerReseau("none", { driver: "null" });
      if (!this.secondaire) courant = this;
    }

    /* -------------------------------------------------------- images */
    static ref(nom) {
      let n = nom.replace(/^docker\.io\//, "").replace(/^library\//, "");
      const at = n.indexOf("@"); if (at > 0) n = n.slice(0, at);
      const dernier = n.lastIndexOf("/"); const deux = n.lastIndexOf(":");
      if (deux <= dernier) n += ":latest";
      const k = n.lastIndexOf(":");
      return { repo: n.slice(0, k), tag: n.slice(k + 1), ref: n.slice(0, k) + ":" + n.slice(k + 1) };
    }
    image(nom) {
      if (!nom) return null;
      const r = Moteur.ref(nom);
      if (this.images.has(r.ref)) return this.images.get(r.ref);
      const id = nom.replace(/^sha256:/, "");
      if (/^[0-9a-f]{4,64}$/.test(id)) for (const im of this.images.values()) if (im.id.startsWith(id)) return im;
      return null;
    }
    imageDeBase(r) {
      const b = BASES[r.repo]; if (!b || !b.tags[r.tag]) return null;
      const id = b.tags[r.tag] + D.hexDe(r.ref, 52);
      const fichiers = fsBase(b.famille, b.extra);
      const couches = [{ fichiers, taille: b.contenu, createdBy: "base" }];
      for (let k = 1; k < b.couches; k++) couches.push({ fichiers: new Map(), taille: 0, createdBy: "base" });
      const env = [b.famille === "alpine324" ? "PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" : PATH].concat(b.env || []);
      return {
        id: r.tag === "3.12-alpine" && b.digest ? b.digest : id, tags: [r.ref], digest: b.digest || id, base: r.repo, famille: b.famille, variante: b.variante, programme: b.programme || null,
        couches, cree: H.now() - 12 * 86400000, disque: b.disque, contenu: b.contenu, repoDigests: [`${r.repo}@sha256:${b.digest || id}`],
        config: { Cmd: b.cmd, Entrypoint: b.entrypoint || null, Env: env, User: "", WorkingDir: b.workdir || "", ExposedPorts: Object.fromEntries((b.expose || []).map((p) => [p, {}])), Volumes: b.volumes ? Object.fromEntries(b.volumes.map((v) => [v, {}])) : null, Labels: null, StopSignal: b.stop || "SIGTERM" },
        historique: b.historique || null, stop: b.arret || 10000,
      };
    }
    // docker pull implicite (run, create, build) ou explicite.
    tirer(nom, l, o = {}) {
      const r = Moteur.ref(nom);
      const deja = this.image(nom);
      if (deja && !o.force) return deja;
      if (/^localhost:\d+\//.test(r.ref) || /^127\.0\.0\.1:\d+\//.test(r.ref)) {
        const im = this.tirerRegistre(r, l, o);
        if (im) return im;
        return null;
      }
      const im = deja || this.imageDeBase(r);
      if (!im) {
        if (o.explicite) l.push({ t: `Error response from daemon: pull access denied for ${r.repo}, repository does not exist or may require 'docker login'`, e: true });
        else l.push({ t: `Unable to find image '${r.ref}' locally`, e: true }, { t: `docker: Error response from daemon: pull access denied for ${r.repo}, repository does not exist or may require 'docker login'`, e: true }, { t: "", e: true }, { t: `Run 'docker ${o.cmd || "run"} --help' for more information`, e: true });
        return null;
      }
      const nomRepo = r.repo.includes("/") ? r.repo : "library/" + r.repo;
      if (deja) {
        l.push({ t: `${r.tag}: Pulling from ${nomRepo}` }, { t: `Digest: sha256:${im.digest}` }, { t: `Status: Image is up to date for ${r.ref}` }, { t: `docker.io/${nomRepo}:${r.tag}` });
        return im;
      }
      const e = !o.explicite;
      if (e) l.push({ t: `Unable to find image '${r.ref}' locally`, e: true });
      l.push({ t: `${r.tag}: Pulling from ${nomRepo}`, e });
      const n = Math.max(1, (BASES[r.repo] || {}).couches || 1);
      for (let k = 0; k < n; k++) l.push({ t: `${D.hexDe(r.ref + k, 12)}: Pull complete`, e, lent: true });
      l.push({ t: `Digest: sha256:${im.digest}`, e }, { t: `Status: Downloaded newer image for ${r.ref}`, e });
      if (o.explicite) l.push({ t: `docker.io/${nomRepo}:${r.tag}` });
      this.images.set(r.ref, im);
      return im;
    }

    /* -------------------------------------------------------- réseaux */
    creerReseau(nom, o = {}) {
      const sr = o.sousReseau || (o.driver === "bridge" || !o.driver ? `172.${this.prochainSousReseau++}.0` : null);
      this.reseaux[nom] = { nom, id: o.id || D.hexDe(nom + H.now(), 64), driver: o.driver || "bridge", sousReseau: sr, passerelle: sr ? sr + ".1" : "", defaut: !!o.defaut, labels: o.labels || {}, cree: H.now(), interne: !!o.interne };
      return this.reseaux[nom];
    }
    ipLibre(nomR) {
      const r = this.reseaux[nomR]; if (!r || !r.sousReseau) return "";
      const prises = new Set(this.conteneurs.filter((c) => c.etat === "running" && c.reseaux[nomR]).map((c) => c.reseaux[nomR].ip));
      for (let k = 2; k < 255; k++) if (!prises.has(`${r.sousReseau}.${k}`)) return `${r.sousReseau}.${k}`;
      return "";
    }

    /* -------------------------------------------------------- conteneurs */
    trouver(nom) {
      if (!nom) return null;
      const n = nom.replace(/^\//, "");
      return this.conteneurs.find((c) => c.nom === n) || this.conteneurs.find((c) => n.length >= 3 && c.idLong.startsWith(n)) || null;
    }
    nomAuHasard() {
      const a = ["nifty", "brave", "eager", "jolly", "quirky", "serene", "zen", "vibrant", "festive", "gallant", "keen", "sharp"];
      const b = ["turing", "hopper", "lovelace", "torvalds", "curie", "noether", "shannon", "ritchie", "babbage", "germain", "hamilton", "meitner"];
      return a[Math.floor(Math.random() * a.length)] + "_" + b[Math.floor(Math.random() * b.length)];
    }
    // Création : o = options déjà analysées (voir analyserRun). Renvoie le conteneur.
    creer(im, o) {
      const idLong = O.hex(64);
      const env = {};
      im.config.Env.forEach((e) => { const k = e.indexOf("="); env[e.slice(0, k)] = e.slice(k + 1); });
      const envUtil = [];
      (o.env || []).forEach((e) => { const k = e.indexOf("="); if (k < 0) { if (this.hote && this.hote.sh.env[e] !== undefined) envUtil.push(e + "=" + this.hote.sh.env[e]); return; } envUtil.push(e); env[e.slice(0, k)] = e.slice(k + 1); });
      const c = {
        id: idLong.slice(0, 12), idLong, nom: o.nom || this.nomAuHasard(), image: o.imageTapee || im.tags[0] || im.id.slice(0, 12), img: im,
        config: {
          Hostname: o.hostname || idLong.slice(0, 12), User: o.user != null ? o.user : im.config.User, WorkingDir: o.workdir || im.config.WorkingDir || "",
          Entrypoint: o.entrypoint !== undefined ? (o.entrypoint ? [o.entrypoint] : null) : im.config.Entrypoint,
          Cmd: o.cmd && o.cmd.length ? o.cmd : o.entrypoint !== undefined ? [] : im.config.Cmd,
          Env: envUtil.concat(im.config.Env.filter((e) => !envUtil.some((u) => u.split("=")[0] === e.split("=")[0]))),
          Labels: Object.assign({}, im.config.Labels || {}, o.labels || {}), ExposedPorts: im.config.ExposedPorts || {},
          Healthcheck: o.health || im.config.Healthcheck || null, Image: o.imageTapee || im.tags[0],
        },
        hostConfig: { Memory: o.memoire || 0, NanoCpus: Math.round((o.cpus || 0) * 1e9), PidsLimit: o.pids || null, CapAdd: o.capAdd && o.capAdd.length ? o.capAdd : null,
          CapDrop: o.capDrop && o.capDrop.length ? o.capDrop : null, Privileged: !!o.privileged, ReadonlyRootfs: !!o.readOnly, SecurityOpt: o.securityOpt && o.securityOpt.length ? o.securityOpt : null,
          RestartPolicy: o.restart || { Name: "no", MaximumRetryCount: 0 }, AutoRemove: !!o.rm, NetworkMode: o.reseau || "bridge", Tmpfs: o.tmpfs || null, Binds: null },
        envMap: env, ports: o.ports || [], cree: H.now(), demarre: null, finit: null, etat: "created", code: 0, oom: false, restartCount: 0,
        logs: [], reseaux: {}, montages: [], upper: new Map(), pidHote: (this.pidHote += 97 + Math.floor(Math.random() * 60)), extra: [],
        labels: o.labels || {}, aliases: o.aliases || [], health: null, proc: null, arretDemande: false, moteur: this,
      };
      // Montages : volumes nommés, anonymes, bind, tmpfs.
      const montages = [];
      (o.vols || []).forEach((v) => {
        const parts = v.split(":");
        let src = parts[0]; let dest = parts[1]; const mode = parts[2] || "";
        if (parts.length === 1) { dest = src; src = ""; }
        const ro = /(^|,)ro($|,)/.test(mode);
        if (src.startsWith("/") || src.startsWith(".") || src.startsWith("~")) {
          const p = chemin.norm(src.replace(/^~/, this.hote.sh.env.HOME), this.hote.sh.cwd);
          if (!this.hote.fs.stat(p)) this.hote.fs.mkdir(p, { parents: true, uid: 0, gid: 0 });
          montages.push({ type: "bind", source: p, dest, ro, fs: this.hote.fs, src: p });
        } else {
          const nomV = src || O.hex(64);
          if (!this.volumes[nomV]) this.creerVolume(nomV, { anonyme: !src });
          montages.push({ type: "volume", nom: nomV, source: `/var/lib/docker/volumes/${nomV}/_data`, dest, ro, fs: this.volumes[nomV].fs, src: "/" });
        }
      });
      (o.mounts || []).forEach((m) => montages.push(m.type === "bind" ? { ...m, fs: this.hote.fs, src: m.source } : m));
      Object.keys(im.config.Volumes || {}).forEach((dest) => {
        if (montages.some((m) => m.dest === dest)) return;
        const nomV = O.hex(64); this.creerVolume(nomV, { anonyme: true });
        montages.push({ type: "volume", nom: nomV, source: `/var/lib/docker/volumes/${nomV}/_data`, dest, ro: false, fs: this.volumes[nomV].fs, src: "/", anonyme: true });
      });
      Object.entries(o.tmpfs || {}).forEach(([dest, opts]) => {
        const fs = new SIM.FSMemoire(); const m = /size=(\w+)/.exec(opts || "");
        montages.push({ type: "tmpfs", source: "", dest, ro: false, fs, src: "/", taille: m ? O.lireTaille(m[1]) : null });
      });
      (o.secrets || []).forEach((s) => montages.push({ type: "bind", source: s.source, dest: s.dest, ro: true, fs: this.hote.fs, src: s.source }));
      c.montages = montages;
      c.fs = new FSConteneur({ couches: im.couches.map((k) => k.fichiers), upper: c.upper, montages, ro: c.hostConfig.ReadonlyRootfs, virtuels: (p) => this.fichierVirtuel(c, p) });
      c.fs.procs = () => this.processus(c).map((p) => p.pid);
      c.fs.uid = 0;
      const reseau = o.reseau || "bridge";
      c.reseauxDemandes = [reseau].concat(o.reseauxSup || []);
      this.conteneurs.push(c);
      return c;
    }
    creerVolume(nom, o = {}) {
      const fs = new SIM.FSMemoire();
      this.volumes[nom] = { nom, fs, cree: H.now(), anonyme: !!o.anonyme, labels: o.labels || {} };
      return this.volumes[nom];
    }
    // Démarre un conteneur créé ou arrêté. Renvoie un message d'erreur ou null.
    demarrer(c, o = {}) {
      SIM.tic();
      // Ports publiés : vérification avant de démarrer.
      const pris = this.portsPris(c);
      for (const p of c.ports) {
        const cle = p.ip + ":" + p.hote;
        if (pris.has(cle) || (p.ip === "0.0.0.0" && [...pris].some((k) => k.endsWith(":" + p.hote))) || pris.has("0.0.0.0:" + p.hote))
          return `failed to set up container networking: driver failed programming external connectivity on endpoint ${c.nom} (${O.hex(64)}): Bind for ${p.ip}:${p.hote} failed: port is already allocated`;
      }
      c.reseaux = {};
      for (const nomR of c.reseauxDemandes) {
        if (!this.reseaux[nomR]) return `failed to set up container networking: network ${nomR} not found`;
        if (this.reseaux[nomR].driver === "null" || this.reseaux[nomR].driver === "host") { c.reseaux[nomR] = { ip: "", aliases: [] }; continue; }
        c.reseaux[nomR] = { ip: this.ipLibre(nomR), aliases: this.reseaux[nomR].defaut ? [] : [c.nom, c.id].concat(c.aliases), mac: "02:42:" + O.hex(8).replace(/(..)(?=.)/g, "$1:") };
      }
      c.etat = "running"; c.demarre = H.now(); c.finit = null; c.code = 0; c.oom = false; c.extra = []; c.arretDemande = false;
      if (!o.relance) c.pidHote = this.pidHote += 97 + Math.floor(Math.random() * 60);
      c.health = c.config.Healthcheck && c.config.Healthcheck.Test && c.config.Healthcheck.Test[0] !== "NONE"
        ? { statut: "starting", echecs: 0, prochain: H.now() + (c.config.Healthcheck.Interval || 30000), journal: [] } : null;
      this.lancerProgramme(c);
      return null;
    }
    portsPris(sauf) {
      const p = new Set();
      this.conteneurs.filter((c) => c !== sauf && c.etat === "running").forEach((c) => c.ports.forEach((x) => p.add(x.ip + ":" + x.hote)));
      (SIM.portsHoteOccupes ? SIM.portsHoteOccupes() : []).forEach((x) => p.add(x));
      return p;
    }
    argv(c) { return (c.config.Entrypoint || []).concat(c.config.Cmd || []); }
    commandeAffichee(c) { return O.joindreArgs(this.argv(c)); }

    /* ------------------------------------------------ programmes et temps */
    // Le programme principal est décrit par c.proc : serveur (tourne sans fin) ou script (instructions + sleep).
    lancerProgramme(c) {
      const im = c.img; const argv = this.argv(c);
      const t = H.now();
      const log = (texte, e = false, ts = t) => c.logs.push({ t: texte, e, ts });
      c.proc = { type: "fini", instr: [], pc: 0, reveil: t };
      const progImage = im.programme;
      const cmdDefaut = JSON.stringify(c.config.Cmd) === JSON.stringify(im.config.Cmd) && JSON.stringify(c.config.Entrypoint) === JSON.stringify(im.config.Entrypoint);
      const serveur = (type) => { c.proc = { type: "serveur", serveur: type }; };
      if (progImage === "hello" && cmdDefaut) { HELLO.replace(/\n$/, "").split("\n").forEach((x) => log(x)); return this.fin(c, 0); }
      if (progImage === "nginx" && (cmdDefaut || (argv[0] === "/docker-entrypoint.sh" && argv[1] === "nginx") || (argv[0] === "nginx" && argv.includes("daemon off;")))) return this.demarrerNginx(c);
      if (progImage === "httpd" && cmdDefaut) return this.demarrerApache(c, "httpd");
      if (progImage === "apache" && cmdDefaut) return this.demarrerApache(c, "apache2");
      if (progImage === "registry" && cmdDefaut) { log(`time="${O.date.iso(t)}" level=info msg="listening on [::]:5000" go.version=go1.23.7 instance.id=${O.hex(8)}-${O.hex(4)}-${O.hex(4)}-${O.hex(4)}-${O.hex(12)} service=registry version=3.0.0`, true); serveur("registry"); c.registre = c.registre || { depots: {} }; return; }
      if (progImage === "mariadb" && cmdDefaut) {
        if (!c.config.Env.some((e) => /^MARIADB_(ROOT_PASSWORD|ALLOW_EMPTY_ROOT_PASSWORD|RANDOM_ROOT_PASSWORD|ROOT_PASSWORD_HASH)=/.test(e) || /^MYSQL_ROOT_PASSWORD=/.test(e))) {
          log(`${O.date.iso(t).replace("T", " ").slice(0, 19)}+00:00 [Note] [Entrypoint]: Entrypoint script for MariaDB Server 1:11.4.8+maria~ubu2404 started.`);
          log(`${O.date.iso(t).replace("T", " ").slice(0, 19)}+00:00 [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified`, true);
          log("\tYou need to specify one of MARIADB_ROOT_PASSWORD, MARIADB_ROOT_PASSWORD_HASH, MARIADB_ALLOW_EMPTY_ROOT_PASSWORD and MARIADB_RANDOM_ROOT_PASSWORD", true);
          return this.fin(c, 1);
        }
        log(`${O.date.iso(t).replace("T", " ").slice(0, 19)} 0 [Note] mariadbd: ready for connections.`, true);
        return serveur("mariadb");
      }
      if (progImage === "postgres" && cmdDefaut) {
        const d = O.date.iso(t).replace("T", " ").replace(/\.\d+Z/, ".000 UTC");
        if (!c.config.Env.some((e) => /^POSTGRES_PASSWORD=./.test(e) || /^POSTGRES_HOST_AUTH_METHOD=trust/.test(e))) {
          ["Error: Database is uninitialized and superuser password is not specified.", "       You must specify POSTGRES_PASSWORD to a non-empty value for the", "       superuser. For example, \"-e POSTGRES_PASSWORD=password\" on \"docker run\"."].forEach((x) => log(x, true));
          return this.fin(c, 1);
        }
        log("PostgreSQL init process complete; ready for start up.");
        [`${d} [1] LOG:  starting PostgreSQL 15.14 (Debian 15.14-1.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`, `${d} [1] LOG:  listening on IPv4 address "0.0.0.0", port 5432`, `${d} [1] LOG:  database system is ready to accept connections`].forEach((x) => log(x, true));
        return serveur("postgres");
      }
      if (progImage === "kic") return serveur("kic");
      if (progImage === "trivy") return this.lancerScript(c, [O.joindreArgs(["trivy"].concat(c.config.Cmd || []))]);
      // Application Python construite : python app.py avec un HTTPServer.
      if ((argv[0] === "python" || argv[0] === "python3") && argv[1] && /\.py$/.test(argv[1])) {
        const f = c.fs.lire(chemin.norm(argv[1], c.config.WorkingDir || "/"));
        if (f.err) { log(`${argv[0]}: can't open file '${chemin.norm(argv[1], c.config.WorkingDir || "/")}': [Errno 2] No such file or directory`, true); return this.fin(c, 2); }
        if (/HTTPServer|serve_forever/.test(f.contenu)) { c.proc = { type: "serveur", serveur: "python", source: f.contenu }; return; }
        return this.lancerScript(c, []);
      }
      if ((argv[0] === "python3" || argv[0] === "python") && argv.length === 1) return this.fin(c, 0);
      // Shell sans terminal : s'arrête aussitôt.
      if (argv.length === 1 && ["/bin/sh", "sh", "/bin/bash", "bash"].includes(argv[0])) return this.fin(c, 0);
      // Script : sh -c '...' ou commande simple.
      if (["sh", "/bin/sh", "bash", "/bin/bash"].includes(argv[0]) && argv[1] === "-c") return this.lancerScript(c, D.instructions(argv.slice(2).join(" ")));
      if ((argv[0] === "/docker-entrypoint.sh" || argv[0] === "docker-entrypoint.sh") && argv.length > 1) return this.lancerScript(c, [O.joindreArgs(argv.slice(1))]);
      if (argv[0] === "docker-php-entrypoint" && argv.length > 1) return this.lancerScript(c, [O.joindreArgs(argv.slice(1))]);
      return this.lancerScript(c, [O.joindreArgs(argv)]);
    }
    lancerScript(c, instr) { c.proc = { type: "script", instr, pc: 0, reveil: H.now() }; this.avancer(c, H.now()); }
    fin(c, code, oom) {
      c.etat = "exited"; c.code = code; c.oom = !!oom; c.finit = c.proc && c.proc.tFin ? c.proc.tFin : H.now(); c.proc = null; if (c.health) c.health.statut = c.health.statut;
      c.reseaux = Object.fromEntries(Object.entries(c.reseaux).map(([k, v]) => [k, { ...v, ip: "" }]));
      // Politique de redémarrage.
      const pol = c.hostConfig.RestartPolicy || { Name: "no" };
      const relancer = !c.arretDemande && (pol.Name === "always" || pol.Name === "unless-stopped" || (pol.Name === "on-failure" && code !== 0 && (!pol.MaximumRetryCount || c.restartCount < pol.MaximumRetryCount)));
      if (relancer) { c.etat = "restarting"; c.relanceA = c.finit + 100 * 2 ** c.restartCount; }
      if (c.hostConfig.AutoRemove && !relancer && !c.garder) this.retirer(c);
    }
    retirer(c) {
      c.montages.filter((m) => m.type === "volume" && this.volumes[m.nom] && this.volumes[m.nom].anonyme && c.hostConfig.AutoRemove).forEach((m) => delete this.volumes[m.nom]);
      this.conteneurs = this.conteneurs.filter((x) => x !== c);
    }
    shellPour(c, o = {}) {
      const user = o.user !== undefined ? o.user : c.config.User;
      const uid = this.uidDe(c, user);
      c.fs.uid = uid;
      const env = Object.assign({ HOSTNAME: c.config.Hostname, HOME: uid === 0 ? "/root" : "/home/" + (user || "") }, c.envMap, o.env || {});
      return new SIM.Shell({ fs: c.fs, cwd: o.workdir || c.config.WorkingDir || "/", env, variante: c.img.variante === "dash" ? "dash" : "sh", commandes: D.commandesConteneur, ctx: { conteneur: c, moteur: this, user }, uid });
    }
    uidDe(c, user) {
      if (!user) return 0;
      const u = String(user).split(":")[0];
      if (/^\d+$/.test(u)) return parseInt(u, 10);
      const r = c.fs.lire("/etc/passwd");
      if (!r.err) for (const l of r.contenu.split("\n")) { const k = l.split(":"); if (k[0] === u) return parseInt(k[2], 10); }
      return 0;
    }
    // Fait avancer un conteneur jusqu'à t : instructions du script, sondes de santé, relances.
    avancer(c, t) {
      for (let garde = 0; garde < 500; garde++) {
        const ev = [];
        if (c.etat === "running" && c.proc && c.proc.type === "script" && c.proc.reveil <= t) ev.push(["proc", c.proc.reveil]);
        if (c.etat === "running" && c.health && c.health.prochain <= t) ev.push(["sante", c.health.prochain]);
        if (c.etat === "restarting" && c.relanceA <= t) ev.push(["relance", c.relanceA]);
        if (!ev.length) return;
        ev.sort((a, b) => a[1] - b[1]);
        const [type, quand] = ev[0];
        H.fige = quand;
        try {
          if (type === "proc") this.etapeScript(c, quand);
          else if (type === "sante") this.sonde(c, quand);
          else { c.restartCount++; c.etat = "exited"; this.demarrer(c, { relance: true }); c.demarre = quand; if (c.health) c.health.prochain = quand + (c.config.Healthcheck.Interval || 30000); if (c.proc && c.proc.reveil !== undefined) c.proc.reveil = quand; }
        } finally { H.fige = null; }
      }
    }
    avancerTout(t) { this.conteneurs.slice().forEach((c) => this.avancer(c, t)); }
    etapeScript(c, quand) {
      const p = c.proc;
      while (p.pc < p.instr.length) {
        const ins = p.instr[p.pc++];
        const m = /^(?:sleep\s+(\S+)|tail\s+-f\s+\/dev\/null)$/.exec(ins);
        if (m) {
          if (!m[1] || m[1] === "infinity") { p.reveil = Infinity; return; }
          p.reveil = quand + parseFloat(m[1]) * 1000; return;
        }
        const ex = /^exit(?:\s+(\d+))?$/.exec(ins);
        if (ex) { p.tFin = quand; return this.fin(c, parseInt(ex[1] || String(p.dernier || 0), 10)); }
        const sh = this.shellPour(c);
        const r = sh.executer(ins);
        r.l.forEach((x) => { if (x.t !== undefined && x.t !== "\u0000clear") c.logs.push({ t: x.t, e: !!x.e, ts: quand }); });
        p.dernier = r.code;
        if (c.oomDemande) { c.oomDemande = false; p.tFin = quand; return this.fin(c, 137, true); }
        if (c.infiniDemande) { c.infiniDemande = false; p.reveil = Infinity; return; }
      }
      p.tFin = quand;
      this.fin(c, p.dernier || 0);
    }
    sonde(c, quand) {
      const hc = c.config.Healthcheck; const h = c.health;
      h.prochain = quand + (hc.Interval || 30000);
      const sh = this.shellPour(c);
      const test = hc.Test;
      const r = test[0] === "CMD-SHELL" ? sh.executer(test[1]) : sh.lancer(test.slice(1), null);
      const sortie = R.textes(r.l).join("\n");
      h.journal.push({ Start: O.date.iso(quand), End: O.date.iso(quand + 30), ExitCode: r.code, Output: sortie });
      if (h.journal.length > 5) h.journal.shift();
      if (r.code === 0) { h.statut = "healthy"; h.echecs = 0; return; }
      if (quand < c.demarre + (hc.StartPeriod || 0) && h.statut === "starting") return;
      h.echecs++;
      if (h.echecs >= (hc.Retries || 3)) h.statut = "unhealthy";
    }

    /* --------------------------------------------------- serveurs */
    demarrerNginx(c) {
      const t = H.now(); const log = (x, e = false) => c.logs.push({ t: x, e, ts: t });
      log("/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration");
      log("/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/");
      log("/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh");
      const roConf = !!c.fs.ecrire("/etc/nginx/conf.d/default.conf", "", { ajout: true });
      if (roConf) log("10-listen-on-ipv6-by-default.sh: info: can not modify /etc/nginx/conf.d/default.conf (read-only file system?)");
      else { log("10-listen-on-ipv6-by-default.sh: info: Getting the checksum of /etc/nginx/conf.d/default.conf"); log("10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf"); }
      log("/docker-entrypoint.sh: Sourcing /docker-entrypoint.d/15-local-resolvers.envsh");
      log("/docker-entrypoint.sh: Launching /docker-entrypoint.d/20-envsubst-on-templates.sh");
      log("/docker-entrypoint.sh: Launching /docker-entrypoint.d/30-tune-worker-processes.sh");
      log("/docker-entrypoint.sh: Configuration complete; ready for start up");
      const d = O.date.nginx(t);
      const e1 = c.fs.mkdir("/var/cache/nginx/client_temp", { parents: true });
      if (e1 && e1 !== "EEXIST") {
        log(`${d} [emerg] 1#1: mkdir() "/var/cache/nginx/client_temp" failed (30: ${MSG[e1]})`, true);
        log(`nginx: [emerg] mkdir() "/var/cache/nginx/client_temp" failed (30: ${MSG[e1]})`, true);
        return this.fin(c, 1);
      }
      const e2 = c.fs.ecrire("/var/run/nginx.pid", "1\n"); // dans l'image, /var/run est un lien vers /run
      if (e2 && e2 !== "ENOENT") {
        log(`${d} [emerg] 1#1: open() "/run/nginx.pid" failed (30: ${MSG[e2]})`, true);
        log(`nginx: [emerg] open() "/run/nginx.pid" failed (30: ${MSG[e2]})`, true);
        return this.fin(c, 1);
      }
      [`using the "epoll" event method`, "nginx/1.30.6", "built by gcc 14.2.0 (Debian 14.2.0-19) ", `OS: Linux ${SIM.noyauVersion}`, "getrlimit(RLIMIT_NOFILE): 1024:1048576", "start worker processes"]
        .forEach((x) => log(`${d} [notice] 1#1: ${x}`, true));
      const n = this.cpus(c);
      for (let k = 0; k < n; k++) log(`${d} [notice] 1#1: start worker process ${29 + k}`, true);
      c.proc = { type: "serveur", serveur: "nginx" };
    }
    demarrerApache(c, nom) {
      const t = H.now(); const ip = (Object.values(c.reseaux)[0] || {}).ip || "172.17.0.2";
      c.logs.push({ t: `AH00558: ${nom}: Could not reliably determine the server's fully qualified domain name, using ${ip}. Set the 'ServerName' directive globally to suppress this message`, e: true, ts: t });
      c.logs.push({ t: `AH00558: ${nom}: Could not reliably determine the server's fully qualified domain name, using ${ip}. Set the 'ServerName' directive globally to suppress this message`, e: true, ts: t });
      c.logs.push({ t: `[${O.date.apache(t)}] [${nom === "httpd" ? "mpm_event" : "mpm_prefork"}:notice] [pid 1:tid 1] ${nom === "httpd" ? "AH00489: Apache/2.4.69 (Unix)" : "AH00163: Apache/2.4.69 (Debian) PHP/8.4.27"} configured -- resuming normal operations`, e: true, ts: t });
      c.logs.push({ t: `[${O.date.apache(t)}] [core:notice] [pid 1:tid 1] AH00094: Command line: '${nom} -D FOREGROUND'`, e: true, ts: t });
      const caps = capsEffectives(c);
      if (!(caps.has("SETUID") && caps.has("SETGID")) && !c.config.User) {
        for (let k = 0; k < (nom === "httpd" ? 3 : 5); k++) c.logs.push({ t: `[${O.date.apache(t + k)}] [unixd:alert] [pid ${17 + k}:tid ${17 + k}] (1)Operation not permitted: AH02156: setgid: unable to set group id to Group 33`, e: true, ts: t });
      }
      c.proc = { type: "serveur", serveur: nom };
    }
    cpus(c) { return c.hostConfig.NanoCpus ? Math.max(1, Math.ceil(c.hostConfig.NanoCpus / 1e9)) : SIM.nbCpu || 4; }
    // Programmes du conteneur : pid interne, pid hôte, utilisateur, commande.
    processus(c) {
      if (c.etat !== "running") return [];
      const uid = this.uidDe(c, c.config.User);
      const argv = this.argv(c);
      const liste = [{ pid: 1, pidHote: c.pidHote, uid, cmd: O.joindreArgs(argv).replace(/'/g, "") }];
      const s = c.proc && c.proc.serveur;
      if (s === "nginx") {
        liste[0].cmd = "nginx: master process nginx -g daemon off;";
        for (let k = 0; k < this.cpus(c); k++) liste.push({ pid: 29 + k, pidHote: c.pidHote + 56 + k, uid: uid || 101, cmd: "nginx: worker process" });
      } else if (s === "httpd" || s === "apache2") {
        liste[0].cmd = `${s} -DFOREGROUND`;
        const caps = capsEffectives(c); const ok = caps.has("SETUID") && caps.has("SETGID");
        for (let k = 0; k < (s === "httpd" ? 3 : 5); k++) liste.push({ pid: 17 + k, pidHote: c.pidHote + (s === "httpd" ? 18 : 27) + k + (k ? 0 : 0), uid: uid || (ok ? 33 : 0), cmd: `${s} -DFOREGROUND` });
      } else if (s === "python") liste[0].cmd = argv.join(" ");
      else if (s === "registry") liste[0].cmd = "registry serve /etc/distribution/config.yml";
      else if (s === "mariadb") liste[0].cmd = "mariadbd";
      c.extra = (c.extra || []).filter((x) => !x.fin || x.fin > H.now());
      return liste.concat(c.extra);
    }
    // Requête HTTP vers un conteneur : {code, entetes, corps} ou {refus: true}.
    servir(c, req) {
      if (!c || c.etat !== "running" || !c.proc || c.proc.type !== "serveur") return { refus: true };
      const port = String(req.port);
      const t = H.now(); const de = req.de || "172.17.0.1"; const ua = req.agent || "curl/8.18.0";
      const s = c.proc.serveur;
      const portServi = { nginx: "80", httpd: "80", apache2: "80", registry: "5000", mariadb: "3306", postgres: "5432", python: String((c.envMap.PORT) || 8080) }[s];
      if (port !== portServi) return { refus: true };
      const methode = req.methode || "GET"; const chemReq = req.chemin || "/";
      const repondre = (code, corps, type = "text/html") => ({ code, corps, entetes: { type, longueur: O.octets(corps) } });
      if (s === "nginx" || s === "httpd" || s === "apache2") {
        const racine = s === "nginx" ? "/usr/share/nginx/html" : s === "httpd" ? "/usr/local/apache2/htdocs" : "/var/www/html";
        let p = chemin.norm(chemReq.split("?")[0], "/");
        let f = c.fs.stat(racine + (p === "/" ? "" : p));
        if (f && f.type === "d") { p = (p === "/" ? "" : p) + "/index.html"; f = c.fs.stat(racine + p); if (!f && s === "apache2") p = p.replace(/html$/, "php"); }
        const lu = f ? c.fs.lire(racine + p) : { err: "ENOENT" };
        let rep;
        if (lu.err && s === "apache2" && (chemReq === "/" || chemReq === "")) rep = repondre(403, "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\n<html><head>\n<title>403 Forbidden</title>\n</head><body>\n<h1>Forbidden</h1>\n<p>You don't have permission to access this resource.</p>\n<hr>\n<address>Apache/2.4.69 (Debian) Server at localhost Port 80</address>\n</body></html>\n");
        else if (lu.err) rep = repondre(404, s === "nginx" ? "<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx/1.30.6</center>\n</body>\n</html>\n" : "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>\n");
        else rep = repondre(200, lu.contenu);
        rep.serveur = s === "nginx" ? "nginx/1.30.6" : s === "httpd" ? "Apache/2.4.69 (Unix)" : "Apache/2.4.69 (Debian)";
        rep.modifie = f ? f.mtime : t;
        if (s === "nginx") c.logs.push({ t: `${de} - - [${O.date.clf(t)}] "${methode} ${chemReq} HTTP/1.1" ${rep.code} ${methode === "HEAD" ? 0 : rep.entetes.longueur} "-" "${ua}" "-"`, ts: t });
        else c.logs.push({ t: `${de} - - [${O.date.clf(t)}] "${methode} ${chemReq} HTTP/1.1" ${rep.code} ${rep.entetes.longueur}`, ts: t });
        return rep;
      }
      if (s === "python") {
        const m = /body\s*=\s*b?"((?:[^"\\]|\\.)*)"/.exec(c.proc.source || "") || /b"((?:[^"\\]|\\.)*)"/.exec(c.proc.source || "");
        const corps = m ? m[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"') : "";
        c.logs.push({ t: `${de} - - [${O.date.python(t)}] "${methode} ${chemReq} HTTP/1.1" 200 -`, e: true, ts: t });
        const rep = repondre(200, corps, "text/plain; charset=utf-8"); rep.serveur = "BaseHTTP/0.6 Python/3.12.16"; return rep;
      }
      if (s === "registry") {
        const reg = c.registre || { depots: {} };
        let m;
        if (chemReq === "/v2/" || chemReq === "/v2") return repondre(200, "{}\n", "application/json; charset=utf-8");
        if (chemReq === "/v2/_catalog") return repondre(200, JSON.stringify({ repositories: Object.keys(reg.depots).sort() }) + "\n", "application/json; charset=utf-8");
        if ((m = /^\/v2\/(.+)\/tags\/list$/.exec(chemReq))) {
          if (!reg.depots[m[1]]) return repondre(404, JSON.stringify({ errors: [{ code: "NAME_UNKNOWN", message: "repository name not known to registry", detail: { name: m[1] } }] }) + "\n", "application/json; charset=utf-8");
          return repondre(200, JSON.stringify({ name: m[1], tags: Object.keys(reg.depots[m[1]]).sort() }) + "\n", "application/json; charset=utf-8");
        }
        return repondre(404, "404 page not found\n", "text/plain; charset=utf-8");
      }
      return { refus: true };
    }
    // Résolution DNS vue depuis un conteneur (réseaux définis par l'utilisateur seulement).
    resoudre(depuis, nom) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(nom)) return { ip: nom, cible: this.conteneurs.find((c) => Object.values(c.reseaux).some((r) => r.ip === nom)) || null };
      if (nom === "localhost") return { ip: "127.0.0.1", cible: depuis };
      if (nom === "host.docker.internal") return null;
      for (const [nomR, info] of Object.entries(depuis.reseaux)) {
        const r = this.reseaux[nomR];
        if (!r || r.defaut || !info.ip) continue;
        const cible = this.conteneurs.find((c) => c.etat === "running" && c.reseaux[nomR] && c.reseaux[nomR].ip && (c.nom === nom || (c.reseaux[nomR].aliases || []).includes(nom)));
        if (cible) return { ip: cible.reseaux[nomR].ip, cible };
      }
      return SIM.resoudreExterne ? SIM.resoudreExterne(nom, depuis) : null;
    }
    // Fichiers générés : /proc, cgroups, hostname.
    fichierVirtuel(c, p) {
      const v = (contenu) => ({ type: "f", contenu, uid: 0, gid: 0, mode: 0o444, mtime: c.demarre || H.now(), virtuel: true });
      if (p === "/etc/hostname") return v(c.config.Hostname + "\n");
      if (p === "/etc/resolv.conf") return v(Object.keys(c.reseaux).some((n) => this.reseaux[n] && !this.reseaux[n].defaut) ? "nameserver 127.0.0.11\noptions ndots:0\n" : "nameserver 10.255.255.254\nsearch .\n");
      if (p === "/etc/hosts") return v(`127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n${Object.values(c.reseaux).map((r) => r.ip).filter(Boolean).map((ip) => `${ip}\t${c.config.Hostname}`).join("\n")}\n`);
      if (p === "/proc/self" || p === "/proc/1") return c.etat === "running" ? { type: "d", uid: 0, gid: 0, mode: 0o555, virtuel: true } : null;
      const m = /^\/proc\/(1|self)\/(cmdline|status)$/.exec(p);
      if (m) {
        const pr = this.processus(c)[0]; if (!pr) return null;
        if (m[2] === "cmdline") return v(pr.cmd.replace(/ /g, c.proc && c.proc.serveur === "nginx" ? " " : "\u0000"));
        const caps = capsEffectives(c); const racine = pr.uid === 0;
        const nnp = (c.hostConfig.SecurityOpt || []).some((o) => /^no-new-privileges(:true)?$/.test(o));
        const seccomp = c.hostConfig.Privileged || (c.hostConfig.SecurityOpt || []).includes("seccomp=unconfined") ? 0 : 2;
        const nomP = pr.cmd.split(" ")[0].replace(/:$/, "").replace(/^.*\//, "").slice(0, 15);
        return v(`Name:\t${nomP}\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t1\nNgid:\t0\nPid:\t1\nPPid:\t0\nTracerPid:\t0\nUid:\t${pr.uid}\t${pr.uid}\t${pr.uid}\t${pr.uid}\nGid:\t${pr.uid}\t${pr.uid}\t${pr.uid}\t${pr.uid}\nFDSize:\t64\nGroups:\t\nThreads:\t1\nCapInh:\t0000000000000000\nCapPrm:\t${racine ? masque(caps) : "0000000000000000"}\nCapEff:\t${racine ? masque(caps) : "0000000000000000"}\nCapBnd:\t${masque(caps)}\nCapAmb:\t0000000000000000\nNoNewPrivs:\t${nnp ? 1 : 0}\nSeccomp:\t${seccomp}\nSeccomp_filters:\t${seccomp ? 1 : 0}\nSpeculation_Store_Bypass:\tthread vulnerable\nCpus_allowed_list:\t0-${(SIM.nbCpu || 4) - 1}\n`);
      }
      if (p === "/sys/fs/cgroup/memory.max") return v((c.hostConfig.Memory ? String(c.hostConfig.Memory) : "max") + "\n");
      if (p === "/sys/fs/cgroup/pids.max") return v((c.hostConfig.PidsLimit ? String(c.hostConfig.PidsLimit) : "max") + "\n");
      if (p === "/sys/fs/cgroup/cpu.max") return v((c.hostConfig.NanoCpus ? `${Math.round(c.hostConfig.NanoCpus / 1e4)} 100000` : "max 100000") + "\n");
      if (p === "/sys/fs/cgroup/memory.current") return v(String(Math.round(((BASES[c.img.base] || {}).mem || 4) * 1048576)) + "\n");
      if (p === "/sys/fs/cgroup/pids.current") return v(String(this.processus(c).length) + "\n");
      return null;
    }

    /* --------------------------------------------- vues pour inspect et ps */
    statut(c) {
      const now = H.now();
      if (c.etat === "running") return "Up " + O.duree(now - c.demarre) + (c.health ? { starting: " (health: starting)", healthy: " (healthy)", unhealthy: " (unhealthy)" }[c.health.statut] : "");
      if (c.etat === "restarting") return `Restarting (${c.code}) ${O.duree(now - c.finit)} ago`;
      if (c.etat === "created") return "Created";
      return `Exited (${c.code}) ${O.duree(now - c.finit)} ago`;
    }
    portsTexte(c) {
      if (c.etat !== "running") return "";
      const pub = c.ports.map((p) => `${p.ip === "0.0.0.0" ? "0.0.0.0" : p.ip}:${p.hote}->${p.ctn}/${p.proto || "tcp"}${p.ip === "0.0.0.0" ? `, [::]:${p.hote}->${p.ctn}/${p.proto || "tcp"}` : ""}`);
      const exposes = Object.keys(c.config.ExposedPorts || {}).filter((e) => !c.ports.some((p) => `${p.ctn}/${p.proto || "tcp"}` === e));
      return exposes.concat(pub).join(", ");
    }
    vueInspect(c) {
      const d = (t) => (t ? O.date.iso(t).replace("Z", "000000Z").replace(/\.(\d{3})000000Z/, ".$1000000Z") : "0001-01-01T00:00:00Z");
      const ports = {};
      Object.keys(c.config.ExposedPorts || {}).forEach((e) => { ports[e] = null; });
      c.ports.forEach((p) => { ports[`${p.ctn}/${p.proto || "tcp"}`] = [{ HostIp: p.ip, HostPort: String(p.hote) }]; });
      return {
        Id: c.idLong, Created: d(c.cree), Path: this.argv(c)[0] || "", Args: this.argv(c).slice(1),
        State: { Status: c.etat, Running: c.etat === "running", Paused: false, Restarting: c.etat === "restarting", OOMKilled: c.oom, Dead: false,
          Pid: c.etat === "running" ? c.pidHote : 0, ExitCode: c.code, Error: "", StartedAt: d(c.demarre), FinishedAt: d(c.finit),
          ...(c.health || c.config.Healthcheck ? { Health: { Status: c.health ? c.health.statut : "starting", FailingStreak: c.health ? c.health.echecs : 0, Log: c.health ? c.health.journal : [] } } : {}) },
        Image: "sha256:" + c.img.id, ResolvConfPath: `/var/lib/docker/containers/${c.idLong}/resolv.conf`, Name: "/" + c.nom, RestartCount: c.restartCount,
        Driver: "overlayfs", Platform: "linux", MountLabel: "", ProcessLabel: "", AppArmorProfile: "docker-default",
        HostConfig: { Binds: c.montages.filter((m) => m.type === "bind" && !m.secret).map((m) => `${m.source}:${m.dest}${m.ro ? ":ro" : ""}`), NetworkMode: c.hostConfig.NetworkMode,
          PortBindings: Object.fromEntries(c.ports.map((p) => [`${p.ctn}/${p.proto || "tcp"}`, [{ HostIp: p.ip, HostPort: String(p.hote) }]])),
          RestartPolicy: c.hostConfig.RestartPolicy, AutoRemove: c.hostConfig.AutoRemove, CapAdd: c.hostConfig.CapAdd, CapDrop: c.hostConfig.CapDrop,
          Privileged: c.hostConfig.Privileged, ReadonlyRootfs: c.hostConfig.ReadonlyRootfs, SecurityOpt: c.hostConfig.SecurityOpt, Tmpfs: c.hostConfig.Tmpfs,
          Memory: c.hostConfig.Memory, NanoCpus: c.hostConfig.NanoCpus, PidsLimit: c.hostConfig.PidsLimit, MemorySwap: c.hostConfig.Memory ? c.hostConfig.Memory * 2 : 0 },
        Mounts: c.montages.map((m) => (m.type === "volume" ? { Type: "volume", Name: m.nom, Source: m.source, Destination: m.dest, Driver: "local", Mode: m.ro ? "ro" : "z", RW: !m.ro, Propagation: "" }
          : m.type === "tmpfs" ? { Type: "tmpfs", Source: "", Destination: m.dest, Mode: "", RW: true, Propagation: "" }
          : { Type: "bind", Source: m.source, Destination: m.dest, Mode: m.ro ? "ro" : "", RW: !m.ro, Propagation: "rprivate" })),
        Config: { Hostname: c.config.Hostname, Domainname: "", User: c.config.User || "", AttachStdin: false, AttachStdout: false, AttachStderr: false, ExposedPorts: c.config.ExposedPorts,
          Tty: false, Env: c.config.Env, Cmd: c.config.Cmd, Healthcheck: c.config.Healthcheck ? { Test: c.config.Healthcheck.Test, Interval: (c.config.Healthcheck.Interval || 0) * 1e6, Retries: c.config.Healthcheck.Retries } : undefined,
          Image: c.config.Image, WorkingDir: c.config.WorkingDir || "", Entrypoint: c.config.Entrypoint, Labels: c.config.Labels },
        NetworkSettings: { Ports: c.etat === "running" ? ports : {}, Networks: Object.fromEntries(Object.entries(c.reseaux).length ? Object.entries(c.reseaux).map(([n, r]) => [n, { Aliases: (r.aliases || []).filter((a) => a !== c.id && a !== c.nom).length ? r.aliases : null, NetworkID: this.reseaux[n] ? this.reseaux[n].id : "", Gateway: r.ip && this.reseaux[n] ? this.reseaux[n].passerelle : "", IPAddress: r.ip || "", IPPrefixLen: r.ip ? 16 : 0, MacAddress: r.ip ? r.mac : "", DNSNames: r.aliases && r.aliases.length ? r.aliases : null }])
          : c.reseauxDemandes.map((n) => [n, { NetworkID: this.reseaux[n] ? this.reseaux[n].id : "", Gateway: "", IPAddress: "", IPPrefixLen: 0, MacAddress: "" }])) },
      };
    }
    vuePs(c) {
      return { ID: c.id, Image: c.image, Command: O.quoteGo(O.ellipse(this.commandeAffichee(c), 20)), CreatedAt: O.date.iso(c.cree).replace("T", " ").replace(/\.\d+Z/, " +0000 UTC"),
        RunningFor: O.duree(H.now() - c.cree) + " ago", Ports: this.portsTexte(c), Status: this.statut(c), State: c.etat, Names: c.nom, Size: "0B",
        Labels: Object.entries(c.config.Labels || {}).map(([k, v]) => `${k}=${v}`).join(","), Mounts: c.montages.map((m) => m.nom ? m.nom.slice(0, 15) + (m.nom.length > 15 ? "…" : "") : m.source).join(","),
        Networks: Object.keys(c.reseaux).length ? Object.keys(c.reseaux).join(",") : c.reseauxDemandes.join(","), LocalVolumes: String(c.montages.filter((m) => m.type === "volume").length) };
    }
  }
  D.Moteur = Moteur;
  D.courant = () => courant;

  /* ----------------------------------------------------- analyse de docker run */
  const AVEC_VALEUR = new Set(["--name", "-p", "--publish", "-e", "--env", "-v", "--volume", "--network", "--net", "-m", "--memory", "--cpus", "--pids-limit",
    "--cap-add", "--cap-drop", "-u", "--user", "--restart", "--security-opt", "--tmpfs", "-w", "--workdir", "--hostname", "-h", "--health-cmd",
    "--health-interval", "--health-retries", "--health-timeout", "--health-start-period", "--entrypoint", "-l", "--label", "--env-file",
    "--network-alias", "--mount", "--stop-timeout", "--platform", "--pull", "--add-host", "--dns", "--ulimit", "--memory-swap", "--log-driver", "--expose", "--cidfile", "--stop-signal"]);
  const BOOLEENS = new Set(["-d", "--detach", "--rm", "-i", "-t", "--interactive", "--tty", "--privileged", "--read-only", "--init", "-P", "--publish-all", "--no-healthcheck", "-q", "--quiet", "--sig-proxy"]);
  D.analyserRun = function (args, cmd = "run") {
    const o = { d: false, rm: false, ports: [], env: [], vols: [], capAdd: [], capDrop: [], securityOpt: [], tmpfs: null, labels: {}, mounts: [], aliases: [] };
    let i = 0;
    for (; i < args.length; i++) {
      let a = args[i];
      if (!a.startsWith("-") || a === "-") break;
      let v = null;
      if (a.startsWith("--") && a.includes("=")) { v = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
      if (/^-[a-zA-Z]{2,}$/.test(a) && [...a.slice(1)].every((ch) => "dit".includes(ch))) { if (a.includes("d")) o.d = true; continue; }
      if (/^-[a-zA-Z].+/.test(a) && AVEC_VALEUR.has(a.slice(0, 2)) && !a.startsWith("--")) { v = a.slice(2); a = a.slice(0, 2); }
      if (BOOLEENS.has(a)) { if (a === "-d" || a === "--detach") o.d = true; else if (a === "--rm") o.rm = true; else if (a === "--privileged") o.privileged = true; else if (a === "--read-only") o.readOnly = true; else if (a === "--no-healthcheck") o.health = { Test: ["NONE"] }; continue; }
      if (!AVEC_VALEUR.has(a)) return { erreur: [`unknown ${a.startsWith("--") ? "flag" : "shorthand flag"}: ${a.startsWith("--") ? a : `'${a[1]}' in ${a}`}`, `See 'docker ${cmd} --help'.`] };
      if (v === null) { i++; v = args[i]; if (v === undefined) return { erreur: [`flag needs an argument: ${a}`, `See 'docker ${cmd} --help'.`] }; }
      switch (a) {
        case "--name": o.nom = v; break;
        case "-p": case "--publish": {
          const [spec, proto] = v.split("/"); const p = spec.split(":");
          const [ip, hote, ctn] = p.length === 3 ? p : p.length === 2 ? ["0.0.0.0", p[0], p[1]] : ["0.0.0.0", String(32768 + Math.floor(Math.random() * 1000)), p[0]];
          o.ports.push({ ip: ip || "0.0.0.0", hote: hote || String(32768 + Math.floor(Math.random() * 1000)), ctn, proto: proto || "tcp" });
          break;
        }
        case "-e": case "--env": o.env.push(v); break;
        case "-v": case "--volume": o.vols.push(v); break;
        case "--mount": {
          const kv = Object.fromEntries(v.split(",").map((x) => { const [k, w] = x.split("="); return [k, w === undefined ? "true" : w]; }));
          const dest = kv.target || kv.dst || kv.destination; const src = kv.source || kv.src || "";
          const ro = kv.readonly === "true" || kv.ro === "true";
          if (kv.type === "tmpfs") { o.tmpfs = Object.assign(o.tmpfs || {}, { [dest]: kv["tmpfs-size"] ? "size=" + kv["tmpfs-size"] : "" }); break; }
          o.vols.push(`${src}:${dest}${ro ? ":ro" : ""}`); break;
        }
        case "--network": case "--net": if (o.reseau) { o.reseauxSup = (o.reseauxSup || []).concat(v); } else o.reseau = v; break;
        case "--network-alias": o.aliases.push(v); break;
        case "-m": case "--memory": o.memoire = O.lireTaille(v); break;
        case "--cpus": o.cpus = parseFloat(v); break;
        case "--pids-limit": o.pids = parseInt(v, 10); break;
        case "--cap-add": o.capAdd.push(nomCap(v)); break;
        case "--cap-drop": o.capDrop.push(nomCap(v)); break;
        case "-u": case "--user": o.user = v; break;
        case "--restart": { const [n, max] = v.split(":"); if (!["no", "always", "unless-stopped", "on-failure"].includes(n)) return { erreur: [`docker: Error response from daemon: invalid restart policy '${v}'`] }; o.restart = { Name: n, MaximumRetryCount: parseInt(max || "0", 10) }; break; }
        case "--security-opt": o.securityOpt.push(v === "no-new-privileges:true" ? "no-new-privileges:true" : v); break;
        case "--tmpfs": { const [dest, opts] = v.split(/:(.*)/s); o.tmpfs = Object.assign(o.tmpfs || {}, { [dest]: opts || "" }); break; }
        case "-w": case "--workdir": o.workdir = v; break;
        case "-h": case "--hostname": o.hostname = v; break;
        case "--health-cmd": o.health = Object.assign(o.health || {}, { Test: ["CMD-SHELL", v] }); break;
        case "--health-interval": o.health = Object.assign(o.health || {}, { Interval: D.dureeMs(v) }); break;
        case "--health-retries": o.health = Object.assign(o.health || {}, { Retries: parseInt(v, 10) }); break;
        case "--health-timeout": o.health = Object.assign(o.health || {}, { Timeout: D.dureeMs(v) }); break;
        case "--health-start-period": o.health = Object.assign(o.health || {}, { StartPeriod: D.dureeMs(v) }); break;
        case "--entrypoint": o.entrypoint = v; break;
        case "-l": case "--label": { const k = v.indexOf("="); o.labels[k < 0 ? v : v.slice(0, k)] = k < 0 ? "" : v.slice(k + 1); break; }
        default: break;
      }
    }
    if (o.health && o.health.Test && o.health.Test[0] !== "NONE") o.health = Object.assign({ Interval: 30000, Timeout: 30000, Retries: 3, StartPeriod: 0 }, o.health);
    o.image = args[i];
    o.cmd = args.slice(i + 1);
    return o;
  };

  /* -------------------------------------------------- la commande docker */
  const ERR = (t, code = 1) => R.err(t, code);
  const nonTrouve = (n) => `Error response from daemon: No such container: ${n}`;
  const DOCKER = (D.commandes = {});

  DOCKER.run = function (m, args, x, cmd = "run") {
    const o = D.analyserRun(args, cmd);
    if (o.erreur) return R.err(o.erreur, 125);
    if (!o.image) return R.err([`docker: '${cmd}' requires at least 1 argument`, "", `Usage:  docker ${cmd} [OPTIONS] IMAGE [COMMAND] [ARG...]`, "", `See 'docker ${cmd} --help' for more information`], 125);
    const l = [];
    if (o.nom) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(o.nom)) return R.err(`docker: Error response from daemon: Invalid container name (${o.nom}), only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed.`, 125);
      const ex = m.conteneurs.find((c) => c.nom === o.nom);
      if (ex) return R.err([`docker: Error response from daemon: Conflict. The container name "/${o.nom}" is already in use by container "${ex.idLong}". You have to remove (or rename) that container to be able to reuse that name.`, "", `Run 'docker ${cmd} --help' for more information`], 125);
    }
    if (o.memoire && o.memoire < 6 * 1048576) return R.err([`docker: Error response from daemon: Minimum memory limit allowed is 6MB.`, "", `Run 'docker ${cmd} --help' for more information`], 125);
    const reseau = o.reseau || "bridge";
    if (!m.reseaux[reseau] && !/^container:/.test(reseau)) {
      // l'image est tirée avant l'erreur réseau, comme en vrai
      const im0 = m.tirer(o.image, l, { cmd });
      if (!im0) return { l, code: 125 };
      l.push({ t: `docker: Error response from daemon: failed to set up container networking: network ${reseau} not found`, e: true }, { t: "", e: true }, { t: `Run 'docker ${cmd} --help' for more information`, e: true });
      return { l, code: 125 };
    }
    const im = m.tirer(o.image, l, { cmd });
    if (!im) return { l, code: 125 };
    o.imageTapee = o.image;
    const c = m.creer(im, o);
    if (cmd === "create") { l.push({ t: c.idLong }); return { l, code: 0 }; }
    if (o.d) l.push({ t: c.idLong });
    const err = m.demarrer(c);
    if (err) {
      l.push({ t: `docker: Error response from daemon: ${err}`, e: true }, { t: "", e: true }, { t: `Run 'docker ${cmd} --help' for more information`, e: true });
      return { l, code: 125 };
    }
    if (o.d) { c.logsLus = c.logs.length; return { l, code: 0 }; }
    // Au premier plan : on suit le programme jusqu'à sa fin (avance l'horloge si besoin).
    let lus = 0; const t0 = H.now();
    const vider = () => { for (; lus < c.logs.length; lus++) l.push({ t: c.logs[lus].t, e: c.logs[lus].e }); };
    c.garder = true;
    for (let k = 0; k < 200 && c.etat === "running"; k++) {
      vider();
      const p = c.proc;
      if (!p || p.type !== "script" || p.reveil === Infinity) break;
      const attente = p.reveil - H.now();
      if (attente > 0) { if (H.now() - t0 + attente > 3600000) break; l.push({ pause: attente }); H.avancer(attente); } else m.avancer(c, H.now());
    }
    c.garder = false;
    vider();
    if (c.etat === "running" || c.etat === "restarting") {
      l.push({ t: `(simulateur : « ${c.nom} » tourne au premier plan ; dans un vrai terminal il occuperait la console jusqu'à Ctrl+C. Ici il continue en arrière-plan : ajoute -d la prochaine fois.)`, e: true, info: true });
      return { l, code: 0 };
    }
    const code = c.code;
    if (c.hostConfig.AutoRemove) m.retirer(c);
    return { l, code };
  };
  DOCKER.create = (m, a, x) => DOCKER.run(m, a, x, "create");

  DOCKER.start = function (m, args) {
    const l = []; let code = 0;
    for (const n of args.filter((v) => !v.startsWith("-"))) {
      const c = m.trouver(n);
      if (!c) { l.push({ t: nonTrouve(n), e: true }); code = 1; continue; }
      if (c.etat !== "running") { c.restartCount = c.etat === "restarting" ? c.restartCount : c.restartCount; const e = m.demarrer(c); if (e) { l.push({ t: `Error response from daemon: ${e}`, e: true }, { t: `Error: failed to start containers: ${n}`, e: true }); code = 1; continue; } }
      l.push({ t: n });
    }
    return { l, code };
  };
  // Arrêt : SIGTERM puis SIGKILL après le délai de grâce (10 s), comme docker stop.
  D.arreter = function (m, c, o = {}) {
    if (c.etat !== "running" && c.etat !== "restarting") return 0;
    c.arretDemande = true;
    if (c.etat === "restarting") { c.etat = "exited"; return 0; }
    const s = c.proc && c.proc.serveur;
    const gracieux = ["nginx", "httpd", "apache2", "registry", "mariadb", "postgres", "kic"].includes(s);
    const delai = o.kill ? 0 : gracieux ? c.img.stop || 500 : (o.t !== undefined ? o.t * 1000 : 10000);
    if (delai) H.avancer(delai);
    c.proc = c.proc || {}; c.proc.tFin = H.now();
    m.fin(c, o.kill ? 137 : gracieux ? 0 : 137);
    return delai;
  };
  DOCKER.stop = function (m, args, x, kill) {
    const { o, ops } = SIM.options(args, ["t", "time", "s", "signal"]);
    const l = []; let code = 0;
    for (const n of ops) {
      const c = m.trouver(n);
      if (!c) { l.push({ t: nonTrouve(n), e: true }); code = 1; continue; }
      if (kill && c.etat !== "running") { l.push({ t: `Error response from daemon: cannot kill container: ${n}: container ${c.idLong} is not running`, e: true }); code = 1; continue; }
      const d = D.arreter(m, c, { kill, t: o.t !== undefined ? parseInt(o.t, 10) : o.time !== undefined ? parseInt(o.time, 10) : undefined });
      if (d) l.push({ pause: d });
      l.push({ t: n });
    }
    return { l, code };
  };
  DOCKER.kill = (m, a, x) => DOCKER.stop(m, a, x, true);
  DOCKER.restart = function (m, args) {
    const l = []; let code = 0;
    for (const n of args.filter((v) => !v.startsWith("-"))) {
      const c = m.trouver(n);
      if (!c) { l.push({ t: nonTrouve(n), e: true }); code = 1; continue; }
      const d = D.arreter(m, c); if (d) l.push({ pause: d });
      const e = m.demarrer(c); if (e) { l.push({ t: `Error response from daemon: ${e}`, e: true }); code = 1; continue; }
      l.push({ t: n });
    }
    return { l, code };
  };
  DOCKER.rm = function (m, args) {
    const { o, ops } = SIM.options(args);
    const l = []; let code = 0;
    if (!ops.length) return R.err(["docker: 'docker rm' requires at least 1 argument", "", "Usage:  docker rm [OPTIONS] CONTAINER [CONTAINER...]", "", "See 'docker rm --help' for more information"], 1);
    for (const n of ops) {
      const c = m.trouver(n);
      if (!c) { l.push({ t: nonTrouve(n), e: true }); code = 1; continue; }
      if ((c.etat === "running" || c.etat === "restarting") && !(o.f || o.force)) { l.push({ t: `Error response from daemon: cannot remove container "${c.nom}": container is running: stop the container before removing or force remove`, e: true }); code = 1; continue; }
      if (c.etat === "running") D.arreter(m, c, { kill: true });
      c.montages.filter((v) => v.type === "volume" && v.anonyme !== false && m.volumes[v.nom] && m.volumes[v.nom].anonyme && (o.v || o.volumes)).forEach((v) => delete m.volumes[v.nom]);
      m.conteneurs = m.conteneurs.filter((v) => v !== c);
      l.push({ t: n });
    }
    return { l, code };
  };
  DOCKER.ps = function (m, args) {
    const { o } = SIM.options(args, ["f", "filter", "format", "n", "last"]);
    const filtres = [];
    args.forEach((a, k) => { if (a === "-f" || a === "--filter") filtres.push(args[k + 1]); else if (a.startsWith("--filter=")) filtres.push(a.slice(9)); });
    let liste = m.conteneurs.filter((c) => o.a || o.all || c.etat === "running" || c.etat === "restarting");
    const parCle = {};
    filtres.forEach((f) => { const k = f.indexOf("="); (parCle[f.slice(0, k)] = parCle[f.slice(0, k)] || []).push(f.slice(k + 1)); });
    for (const [k, vals] of Object.entries(parCle)) {
      liste = liste.filter((c) => vals.some((v) => {
        if (k === "name") { try { return new RegExp(v).test(c.nom); } catch (e) { return c.nom.includes(v); } }
        if (k === "status") return c.etat === v || (v === "exited" && c.etat === "exited");
        if (k === "ancestor") return c.image === v || c.img.tags.includes(Moteur.ref(v).ref) || c.img.id.startsWith(v);
        if (k === "network") return Object.keys(c.reseaux).includes(v) || c.reseauxDemandes.includes(v);
        if (k === "label") { const [lk, lv] = v.split("="); return lv === undefined ? lk in c.config.Labels : c.config.Labels[lk] === lv; }
        if (k === "id") return c.idLong.startsWith(v);
        if (k === "health") return c.health && c.health.statut === v;
        if (k === "volume") return c.montages.some((x) => x.nom === v || x.dest === v);
        return true;
      }));
    }
    liste = liste.slice().reverse();
    if (o.l || o.latest) liste = liste.slice(0, 1);
    if (o.q || o.quiet) return R.ok(liste.map((c) => (o["no-trunc"] ? c.idLong : c.id)));
    const vues = liste.map((c) => m.vuePs(c));
    if (o.format) return D.formater(o.format, vues);
    return R.ok(O.tableau([["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"]].concat(vues.map((v) => [v.ID, v.Image, v.Command, v.RunningFor, v.Status, v.Ports, v.Names])), 3, 10));
  };
  DOCKER.logs = function (m, args) {
    const { o, ops } = SIM.options(args, ["n", "tail", "since", "until"]);
    const c = m.trouver(ops[0]);
    if (!c) return R.err(nonTrouve(ops[0] || ""), 1);
    let lignes = c.logs;
    const n = o.n || o.tail;
    if (n !== undefined && n !== "all") lignes = lignes.slice(-parseInt(n, 10));
    const l = lignes.map((x) => ({ t: (o.t || o.timestamps ? O.date.iso(x.ts).replace("Z", "000000Z") + " " : "") + x.t, e: x.e }));
    if (o.f || o.follow) l.push({ t: "(simulateur : -f suivrait le journal en continu ; ici on affiche ce qui existe déjà)", e: true, info: true });
    return { l, code: 0 };
  };
  DOCKER.exec = function (m, args) {
    let i = 0; const opts = { env: {} };
    for (; i < args.length && args[i].startsWith("-"); i++) {
      const a = args[i];
      if (/^-[it]+$/.test(a) || a === "--interactive" || a === "--tty") { opts.it = true; continue; }
      if (a === "-d" || a === "--detach") { opts.d = true; continue; }
      if (a === "--privileged") continue;
      if (["-u", "--user"].includes(a)) { opts.user = args[++i]; continue; }
      if (["-e", "--env"].includes(a)) { const v = args[++i]; const k = v.indexOf("="); opts.env[v.slice(0, k)] = v.slice(k + 1); continue; }
      if (["-w", "--workdir"].includes(a)) { opts.workdir = args[++i]; continue; }
      if (a.startsWith("--user=")) { opts.user = a.slice(7); continue; }
      return R.err([`unknown flag: ${a}`, "See 'docker exec --help'."], 125);
    }
    const nom = args[i]; const prog = args.slice(i + 1);
    if (!nom || !prog.length) return R.err(["docker: 'docker exec' requires at least 2 arguments", "", "Usage:  docker exec [OPTIONS] CONTAINER COMMAND [ARG...]", "", "See 'docker exec --help' for more information"], 1);
    const c = m.trouver(nom);
    if (!c) return R.err(nonTrouve(nom), 1);
    if (c.etat !== "running") return R.err(`Error response from daemon: container ${c.idLong} is not running`, 1);
    return D.executerDans(m, c, prog, opts);
  };
  D.executerDans = function (m, c, prog, opts = {}) {
    if (prog.length === 1 && ["sh", "bash", "/bin/sh", "/bin/bash", "ash"].includes(prog[0]))
      return R.err(`(simulateur : pas de shell interactif ici. Lance plutôt une commande à la fois : docker exec ${c.nom} <commande>, ou docker exec ${c.nom} sh -c '<commandes>'.)`, 0);
    const sh = m.shellPour(c, opts);
    const nomP = prog[0];
    if (!SIM.BUILTINS[nomP] && !D.commandesConteneur[nomP.replace(/^\/(usr\/)?(local\/)?s?bin\//, "")] || (nomP === "bash" && c.img.famille !== "debian" && c.img.famille !== "ubuntu") || (["apk", "adduser"].includes(nomP) && !/alpine/.test(c.img.famille)))
      return R.err(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${nomP}": executable file not found in $PATH`, 127);
    const r = sh.lancer([nomP.replace(/^\/(usr\/)?(local\/)?s?bin\//, "")].concat(prog.slice(1)), null, {});
    if (c.oomDemande) { c.oomDemande = false; c.arretDemande = true; c.proc = c.proc || {}; c.proc.tFin = H.now(); m.fin(c, 137, true); }
    return { l: r.l, code: r.code };
  };
  DOCKER.inspect = function (m, args) {
    const { o, ops } = SIM.options(args, ["f", "format", "type"]);
    const fmt = o.f || o.format;
    const l = []; let code = 0; const objets = [];
    for (const n of ops) {
      const type = o.type;
      const c = !type || type === "container" ? m.trouver(n) : null;
      if (c) { objets.push(m.vueInspect(c)); continue; }
      const im = !type || type === "image" ? m.image(n) : null;
      if (im) { objets.push(D.vueImage(m, im)); continue; }
      const r = (!type || type === "network") && m.reseaux[n];
      if (r) { objets.push(D.vueReseau(m, r)); continue; }
      const v = (!type || type === "volume") && m.volumes[n];
      if (v) { objets.push(D.vueVolume(v)); continue; }
      l.push({ t: `Error: No such object: ${n}`, e: true }); code = 1;
    }
    if (fmt) { const r = D.formater(fmt, objets); return { l: r.l.concat(l), code: r.code || code }; }
    if (objets.length) l.unshift(...JSON.stringify(objets, null, 4).split("\n").map((t) => ({ t })));
    else if (!l.length) l.push({ t: "[]" });
    return { l, code };
  };
  D.vueReseau = (m, r) => ({ Name: r.nom, Id: r.id, Created: O.date.iso(r.cree), Scope: "local", Driver: r.driver, EnableIPv6: false,
    IPAM: { Driver: "default", Options: {}, Config: r.sousReseau ? [{ Subnet: r.sousReseau + ".0/16", Gateway: r.passerelle }] : [] }, Internal: r.interne, Attachable: false, Ingress: false,
    Containers: Object.fromEntries(m.conteneurs.filter((c) => c.etat === "running" && c.reseaux[r.nom]).map((c) => [c.idLong, { Name: c.nom, MacAddress: c.reseaux[r.nom].mac, IPv4Address: c.reseaux[r.nom].ip + "/16", IPv6Address: "" }])),
    Options: {}, Labels: r.labels });
  D.vueVolume = (v) => ({ CreatedAt: O.date.iso(v.cree).replace(/\.\d+Z/, "Z"), Driver: "local", Labels: v.labels, Mountpoint: `/var/lib/docker/volumes/${v.nom}/_data`, Name: v.nom, Options: null, Scope: "local" });
  DOCKER.top = function (m, args) {
    const c = m.trouver(args[0]);
    if (!c) return R.err(nonTrouve(args[0] || ""), 1);
    if (c.etat !== "running") return R.err(`Error response from daemon: container ${c.idLong} is not running`, 1);
    const procs = m.processus(c);
    const nomHote = (uid) => ({ 0: "root", 33: "www-data", 1000: "eleve" }[uid] || String(uid));
    const k = args.indexOf("-o");
    const cols = k >= 0 ? args[k + 1].split(",") : null;
    if (cols && !cols.includes("pid")) return R.err("Error response from daemon: Couldn't find PID field in ps output", 1);
    const val = { uid: (p) => String(p.uid), user: (p) => nomHote(p.uid), pid: (p) => String(p.pidHote), ppid: (p, j) => String(j ? c.pidHote : c.pidHote - 25), cmd: (p) => p.cmd, args: (p) => p.cmd, comm: (p) => p.cmd.split(" ")[0].replace(/:$/, ""), c: () => "0", stime: () => O.date.hms(c.demarre).slice(0, 5), tty: () => "?", time: () => "00:00:00", rss: () => "4096", vsz: () => "12048" };
    const entete = cols ? cols.map((v) => v.toUpperCase()) : ["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"];
    const lignes = procs.map((p, j) => (cols ? cols.map((v) => (val[v] ? val[v](p, j) : "-")) : [nomHote(p.uid), String(p.pidHote), val.ppid(p, j), "0", val.stime(), "?", "00:00:00", p.cmd]));
    return R.ok(O.tableau([entete].concat(lignes), 1, 20));
  };
  DOCKER.diff = function (m, args) {
    const c = m.trouver(args[0]);
    if (!c) return R.err(nonTrouve(args[0] || ""), 1);
    return R.ok(c.fs.diff());
  };
  DOCKER.port = function (m, args) {
    const c = m.trouver(args[0]);
    if (!c) return R.err(nonTrouve(args[0] || ""), 1);
    if (c.etat !== "running") return R.ok();
    let ps = c.ports;
    if (args[1]) ps = ps.filter((p) => `${p.ctn}/${p.proto || "tcp"}` === (args[1].includes("/") ? args[1] : args[1] + "/tcp"));
    return R.ok(ps.flatMap((p) => (args[1] ? [`${p.ip}:${p.hote}`] : [`${p.ctn}/${p.proto || "tcp"} -> ${p.ip}:${p.hote}`].concat(p.ip === "0.0.0.0" ? [`${p.ctn}/${p.proto || "tcp"} -> [::]:${p.hote}`] : []))));
  };
  DOCKER.stats = function (m, args) {
    const { o, ops } = SIM.options(args, ["format"]);
    const liste = (ops.length ? ops.map((n) => m.trouver(n)).filter(Boolean) : m.conteneurs).filter((c) => c.etat === "running");
    const vues = liste.map((c) => {
      const lim = c.hostConfig.Memory || 7.602 * 1024 ** 3;
      const conso = ((BASES[c.img.base] || {}).mem || { nginx: 7.4, httpd: 11.8, apache: 24, mariadb: 82, python: 9, registry: 6 }[c.img.programme] || 0.6) * 1048576;
      const mi = (v) => (v / 1048576).toFixed(v < 10 * 1048576 ? 3 : 2).replace(/\.?0+$/, "") + "MiB";
      return { Container: c.id, ID: c.id, Name: c.nom, CPUPerc: "0.00%", MemUsage: `${mi(conso)} / ${c.hostConfig.Memory ? mi(lim) : "7.602GiB"}`, MemPerc: ((conso / lim) * 100).toFixed(2) + "%", NetIO: "1.25kB / 126B", BlockIO: "0B / 4.1kB", PIDs: String(m.processus(c).length) };
    });
    const l = [];
    if (!(o["no-stream"])) l.push({ t: "(simulateur : une seule mesure ; en vrai l'affichage se rafraîchit jusqu'à Ctrl+C. Ajoute --no-stream.)", e: true, info: true });
    const r = o.format ? D.formater(o.format, vues) : R.ok(O.tableau([["CONTAINER ID", "NAME", "CPU %", "MEM USAGE / LIMIT", "MEM %", "NET I/O", "BLOCK I/O", "PIDS"]].concat(vues.map((v) => [v.ID, v.Name, v.CPUPerc, v.MemUsage, v.MemPerc, v.NetIO, v.BlockIO, v.PIDs])), 3, 10));
    return { l: r.l.concat(l), code: r.code };
  };
  DOCKER.wait = function (m, args) {
    const l = [];
    for (const n of args) { const c = m.trouver(n); if (!c) return R.err(nonTrouve(n), 1); if (c.etat === "running") { const p = c.proc; if (p && p.type === "script" && p.reveil !== Infinity) { const d = p.reveil - H.now(); if (d > 0) { l.push({ pause: d }); H.avancer(d); } } } l.push({ t: String(c.code) }); }
    return { l, code: 0 };
  };
  DOCKER.rename = function (m, args) { const c = m.trouver(args[0]); if (!c) return R.err(nonTrouve(args[0] || ""), 1); c.nom = args[1]; return R.ok(); };

  DOCKER.volume = function (m, args) {
    const [action, ...r] = args;
    const { o, ops } = SIM.options(r, ["f", "filter", "format", "label"]);
    if (action === "create") { const n = ops[0] || O.hex(64); if (!m.volumes[n]) m.creerVolume(n); return R.ok(n); }
    if (action === "ls" || action === "list") {
      let vs = Object.values(m.volumes);
      const f = o.f || o.filter;
      if (f) { const [k, v] = f.split("="); if (k === "name") vs = vs.filter((x) => x.nom.includes(v)); if (k === "dangling") vs = vs.filter((x) => !m.conteneurs.some((c) => c.montages.some((y) => y.nom === x.nom)) === (v === "true")); }
      vs.sort((a, b) => (a.nom < b.nom ? -1 : 1));
      if (o.q || o.quiet) return R.ok(vs.map((v) => v.nom));
      if (o.format) return D.formater(o.format, vs.map((v) => ({ Name: v.nom, Driver: "local", Mountpoint: `/var/lib/docker/volumes/${v.nom}/_data`, Scope: "local", Labels: "" })), { Name: "VOLUME NAME" });
      return R.ok(O.tableau([["DRIVER", "VOLUME NAME"]].concat(vs.map((v) => ["local", v.nom])), 3, 10));
    }
    if (action === "rm" || action === "remove") {
      const l = []; let code = 0;
      for (const n of ops) {
        if (!m.volumes[n]) { l.push({ t: `Error response from daemon: get ${n}: no such volume`, e: true }); code = 1; continue; }
        const util = m.conteneurs.filter((c) => c.montages.some((v) => v.nom === n));
        if (util.length && !(o.f || o.force)) { l.push({ t: `Error response from daemon: remove ${n}: volume is in use - [${util.map((c) => c.idLong).join(", ")}]`, e: true }); code = 1; continue; }
        delete m.volumes[n]; l.push({ t: n });
      }
      return { l, code };
    }
    if (action === "inspect") return DOCKER.inspect(m, ["--type", "volume"].concat(r));
    if (action === "prune") return R.err("(simulateur : « docker volume prune » n'est pas simulé : supprime les volumes un par un avec docker volume rm.)", 1);
    return R.err(`docker: unknown command: docker volume ${action || ""}`, 1);
  };
  DOCKER.network = function (m, args) {
    const [action, ...r] = args;
    const { o, ops } = SIM.options(r, ["f", "filter", "format", "d", "driver", "subnet", "label"]);
    if (action === "create") {
      const n = ops[0];
      if (!n) return R.err("docker: 'docker network create' requires 1 argument", 1);
      if (m.reseaux[n]) return R.err(`Error response from daemon: network with name ${n} already exists`, 1);
      return R.ok(m.creerReseau(n, { driver: o.d || o.driver || "bridge", interne: !!o.internal }).id);
    }
    if (action === "ls" || action === "list") {
      let rs = Object.values(m.reseaux);
      const f = o.f || o.filter;
      if (f) { const [k, v] = f.split("="); if (k === "name") rs = rs.filter((x) => x.nom.includes(v)); if (k === "driver") rs = rs.filter((x) => x.driver === v); }
      rs.sort((a, b) => (a.nom < b.nom ? -1 : 1));
      if (o.q || o.quiet) return R.ok(rs.map((x) => x.id.slice(0, 12)));
      if (o.format) return D.formater(o.format, rs.map((x) => ({ ID: x.id.slice(0, 12), Name: x.nom, Driver: x.driver, Scope: "local" })), { ID: "NETWORK ID" });
      return R.ok(O.tableau([["NETWORK ID", "NAME", "DRIVER", "SCOPE"]].concat(rs.map((x) => [x.id.slice(0, 12), x.nom, x.driver, "local"])), 3, 10));
    }
    if (action === "rm" || action === "remove") {
      const l = []; let code = 0;
      for (const n of ops) {
        const rx = m.reseaux[n] || Object.values(m.reseaux).find((x) => x.id.startsWith(n));
        if (!rx) { l.push({ t: `Error response from daemon: network ${n} not found`, e: true }); code = 1; continue; }
        if (["bridge", "host", "none"].includes(rx.nom)) { l.push({ t: `Error response from daemon: ${rx.nom} is a pre-defined network and cannot be removed`, e: true }); code = 1; continue; }
        const actifs = m.conteneurs.filter((c) => c.etat === "running" && c.reseaux[rx.nom]);
        if (actifs.length) { l.push({ t: `Error response from daemon: error while removing network: network ${rx.nom} has active endpoints (${actifs.map((c) => `name:"${c.nom}" id:"${O.hex(12)}"`).join(", ")})`, e: true }, { t: "exit status 1", e: true }); code = 1; continue; }
        delete m.reseaux[rx.nom]; l.push({ t: n });
      }
      return { l, code };
    }
    if (action === "inspect") return DOCKER.inspect(m, ["--type", "network"].concat(r));
    if (action === "connect") {
      const [nr, nc] = ops; const c = m.trouver(nc);
      if (!m.reseaux[nr]) return R.err(`Error response from daemon: network ${nr} not found`, 1);
      if (!c) return R.err(nonTrouve(nc), 1);
      c.reseauxDemandes.push(nr);
      if (c.etat === "running") c.reseaux[nr] = { ip: m.ipLibre(nr), aliases: [c.nom, c.id], mac: "02:42:" + O.hex(8).replace(/(..)(?=.)/g, "$1:") };
      return R.ok();
    }
    if (action === "disconnect") { const [nr, nc] = ops; const c = m.trouver(nc); if (!c) return R.err(nonTrouve(nc), 1); delete c.reseaux[nr]; c.reseauxDemandes = c.reseauxDemandes.filter((x) => x !== nr); return R.ok(); }
    return R.err(`docker: unknown command: docker network ${action || ""}`, 1);
  };
  DOCKER.container = function (m, args, x) {
    const [action, ...r] = args;
    const alias = { ls: "ps", list: "ps", remove: "rm" }[action] || action;
    if (!DOCKER[alias]) return R.err(`docker: unknown command: docker container ${action || ""}`, 1);
    return DOCKER[alias](m, r, x);
  };
  DOCKER.version = function (m, args) {
    const { o } = SIM.options(args, ["f", "format"]);
    const f = o.f || o.format;
    const v = { Client: { Version: "29.8.0", ApiVersion: "1.52", GoVersion: "go1.25.3", Os: "linux", Arch: "amd64" }, Server: { Version: "29.8.0", ApiVersion: "1.52", Os: "linux", Arch: "amd64", KernelVersion: SIM.noyauVersion } };
    if (f) return D.formater(f, [v]);
    return R.ok(["Client: Docker Engine - Community", " Version:           29.8.0", " API version:       1.52", " Go version:        go1.25.3", " Git commit:        88096ef", " OS/Arch:           linux/amd64", " Context:           default", "",
      "Server: Docker Engine - Community", " Engine:", "  Version:          29.8.0", "  API version:      1.52 (minimum version 1.24)", "  Go version:       go1.25.3", "  OS/Arch:          linux/amd64", "  Experimental:     false", " containerd:", "  Version:          v2.3.5", " runc:", "  Version:          1.5.1", " docker-init:", "  Version:          0.19.0"]);
  };
  DOCKER.info = function (m, args) {
    const { o } = SIM.options(args, ["f", "format"]);
    const f = o.f || o.format;
    const run = m.conteneurs.filter((c) => c.etat === "running").length;
    const v = { ID: "6c1a2f0e-3d5b-4e7a-9f2c-8b1d0e4a7c63", Containers: m.conteneurs.length, ContainersRunning: run, ContainersPaused: 0, ContainersStopped: m.conteneurs.length - run,
      Images: new Set([...m.images.values()].map((i) => i.id)).size, Driver: "overlayfs", CgroupDriver: "systemd", CgroupVersion: "2", KernelVersion: SIM.noyauVersion, OperatingSystem: "Ubuntu 26.04 LTS",
      OSType: "linux", Architecture: "x86_64", NCPU: SIM.nbCpu || 4, MemTotal: 8162783232, Name: "lab", ServerVersion: "29.8.0", SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"], DockerRootDir: "/var/lib/docker" };
    if (f) return D.formater(f, [v]);
    return R.ok(["Client: Docker Engine - Community", " Version:    29.8.0", " Context:    default", "", "Server:", ` Containers: ${v.Containers}`, `  Running: ${run}`, "  Paused: 0", `  Stopped: ${v.ContainersStopped}`, ` Images: ${v.Images}`,
      " Server Version: 29.8.0", " Storage Driver: overlayfs", "  driver-type: io.containerd.snapshotter.v1", " Logging Driver: json-file", " Cgroup Driver: systemd", " Cgroup Version: 2",
      " Security Options:", "  apparmor", "  seccomp", "   Profile: builtin", "  cgroupns", ` Kernel Version: ${SIM.noyauVersion}`, " Operating System: Ubuntu 26.04 LTS", " OSType: linux", " Architecture: x86_64", ` CPUs: ${v.NCPU}`, " Total Memory: 7.602GiB", " Name: lab", " Docker Root Dir: /var/lib/docker"]);
  };
  DOCKER.system = function (m, args) {
    if (args[0] === "info") return DOCKER.info(m, args.slice(1));
    if (args[0] === "df") {
      const ims = [...new Set(m.images.values())];
      return R.ok(O.tableau([["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"], ["Images", String(ims.length), String(ims.filter((i) => m.conteneurs.some((c) => c.img === i)).length), O.tailleDocker(ims.reduce((s, i) => s + i.disque, 0)), "0B (0%)"],
        ["Containers", String(m.conteneurs.length), String(m.conteneurs.filter((c) => c.etat === "running").length), "0B", "0B"], ["Local Volumes", String(Object.keys(m.volumes).length), "0", "0B", "0B"], ["Build Cache", String(m.cacheBuild.size), "0", "0B", "0B"]], 3, 10));
    }
    return R.err("(simulateur : « docker system " + (args[0] || "") + " » n'est pas simulé ici.)", 1);
  };
  DOCKER.help = function () {
    return R.ok(["", "Usage:  docker [OPTIONS] COMMAND", "", "A self-sufficient runtime for containers", "", "Common Commands:", "  run         Create and run a new container from an image", "  exec        Execute a command in a running container",
      "  ps          List containers", "  build       Build an image from a Dockerfile", "  pull        Download an image from a registry", "  push        Upload an image to a registry", "  images      List images", "  version     Show the Docker version information", "  info        Display system-wide information", "",
      "Management Commands:", "  compose*    Docker Compose", "  container   Manage containers", "  image       Manage images", "  network     Manage networks", "  volume      Manage volumes", "  system      Manage Docker", "",
      "Commands:", "  create      Create a new container", "  diff        Inspect changes to files or directories on a container's filesystem", "  inspect     Return low-level information on Docker objects", "  kill        Kill one or more running containers",
      "  logs        Fetch the logs of a container", "  port        List port mappings or a specific mapping for the container", "  restart     Restart one or more containers", "  rm          Remove one or more containers", "  rmi         Remove one or more images",
      "  start       Start one or more stopped containers", "  stats       Display a live stream of container(s) resource usage statistics", "  stop        Stop one or more running containers", "  tag         Create a tag TARGET_IMAGE that refers to SOURCE_IMAGE",
      "  top         Display the running processes of a container", "", "Run 'docker COMMAND --help' for more information on a command."]);
  };

  // Point d'entrée : docker <sous-commande> ...
  D.docker = function (x) {
    const m = courant;
    const args = x.args.slice();
    while (args[0] && /^(-H|--host|--context|-c|--config|-l|--log-level)$/.test(args[0])) args.splice(0, 2);
    const [sous, ...r] = args;
    if (sous === undefined || sous === "--help" || sous === "help") return DOCKER.help();
    if (sous === "--version" || sous === "-v") return R.ok("Docker version 29.8.0, build 88096ef");
    if (r.includes("--help") && sous !== "compose") return R.ok([`(simulateur : l'aide détaillée de « docker ${sous} » n'est pas reproduite. Elle est sur https://docs.docker.com/reference/cli/docker/${sous}/ .)`]);
    const f = DOCKER[sous];
    if (!f) return R.err([`docker: unknown command: docker ${sous}`, "", "Run 'docker --help' for more information"], 1);
    return f(m, r, x);
  };

  /* ------------------------------------------------ commandes des conteneurs */
  const C = (D.commandesConteneur = Object.assign({}, SIM.UNIX));
  // cmd & dans un conteneur : un processus de plus, refusé au-delà de --pids-limit.
  SIM.lancerFond = function (sh, pipe, texte) {
    const c = sh.ctx && sh.ctx.conteneur; if (!c || !c.idLong) return null;
    const n = (c.moteur || courant).processus(c).length;
    if (c.hostConfig.PidsLimit && n >= c.hostConfig.PidsLimit) { const r = R.err(`${sh.variante === "dash" ? "sh: 0: Cannot fork" : "sh: can't fork: Resource temporarily unavailable"}`, 2); r.sortie = true; return r; }
    const m = /^sleep\s+(\d+)/.exec(texte);
    c.extra.push({ pid: 50 + c.extra.length + 1, pidHote: c.pidHote + 300 + c.extra.length, uid: sh.uid, cmd: texte, fin: m ? H.now() + parseInt(m[1], 10) * 1000 : null });
    return R.ok();
  };
  const ctn = (x) => x.conteneur || (x.sh && x.sh.ctx && x.sh.ctx.conteneur);
  ["sh", "ash", "bash", "dash"].forEach((n) => {
    C[n] = (x) => {
      if (x.args[0] === "-c") { const s = x.sh.sous(); const r = s.executer(x.args[1] || ""); if (r.code === undefined) r.code = s.code; return r; }
      if (x.args[0] && !x.args[0].startsWith("-")) { const f = x.fs.lire(chemin.norm(x.args[0], x.sh.cwd)); if (f.err) return R.err(`${n}: can't open '${x.args[0]}': No such file or directory`, 2); return x.sh.sous().executer(f.contenu); }
      if (x.stdin && x.stdin.length) return x.sh.sous().executer(x.stdin.join("\n"));
      return R.ok();
    };
  });
  C.tail = function (x) {
    if (x.args.includes("/dev/zero")) {
      const c = ctn(x);
      if (c && c.hostConfig.Memory) { c.oomDemande = true; return R.ok([], 137); }
      return R.err("(simulateur : sans limite de mémoire, ce programme finirait par remplir toute la mémoire de la machine. Arrêté par sécurité ; essaie avec --memory.)", 130);
    }
    if (x.args.includes("-f")) { const c = ctn(x); if (c) c.infiniDemande = true; return R.ok(); }
    return SIM.UNIX.tail(x);
  };
  C.ps = function (x) {
    const c = ctn(x); const m = c.moteur || courant;
    const procs = m.processus(c);
    const nom = (uid) => SIM.nomUid(x, uid);
    if (x.variante === "sh") return R.ok(["PID   USER     TIME  COMMAND"].concat(procs.map((p) => `${O.padG(p.pid, 5)} ${O.pad(nom(p.uid), 8)}  0:00 ${p.cmd}`)).concat([`${O.padG(procs.length ? 40 + procs.length : 7, 5)} ${O.pad(nom(x.uid), 8)}  0:00 ps ${x.args.join(" ")}`.trimEnd()]));
    return R.ok(["    PID TTY          TIME CMD"].concat(procs.map((p) => `${O.padG(p.pid, 7)} ?        00:00:00 ${p.cmd.split(" ")[0].replace(/:$/, "")}`)));
  };
  C.df = function (x) {
    const c = ctn(x); const { ops } = SIM.options(x.args);
    const cible = chemin.norm(ops[0] || "/", x.sh.cwd);
    const mnt = c.montages.slice().sort((a, b) => b.dest.length - a.dest.length).find((v) => cible === v.dest || cible.startsWith(v.dest + "/"));
    const h = (n) => { if (!n) return "0"; const u = ["", "K", "M", "G", "T"]; let k = 0; let v = n; while (v >= 1024 && k < 4) { v /= 1024; k++; } return k ? v.toFixed(1) + u[k] : String(n); };
    let fsNom = "overlay"; let taille = 1081154093875; let util = 37795409100; let monte = "/";
    if (mnt) { monte = mnt.dest; if (mnt.type === "tmpfs") { fsNom = "tmpfs"; taille = mnt.taille || 4081391616; util = 0; } else { fsNom = "/dev/sdd"; } }
    const dispo = taille - util; const pct = Math.round((util / taille) * 100);
    if (x.variante === "sh") return R.ok(["Filesystem                Size      Used Available Use% Mounted on", `${O.pad(fsNom, 20)} ${O.padG(h(taille), 9)} ${O.padG(h(util), 9)} ${O.padG(h(dispo), 9)} ${O.padG(pct, 3)}% ${monte}`]);
    return R.ok(["Filesystem      Size  Used Avail Use% Mounted on", `${O.pad(fsNom, 15)} ${O.padG(h(taille), 4)} ${O.padG(h(util), 5)} ${O.padG(h(dispo), 5)} ${O.padG(pct + "%", 4)} ${monte}`]);
  };
  C.hostname = (x) => R.ok(ctn(x).config.Hostname);
  C.nginx = (x) => (x.args.includes("-v") || x.args.includes("-V") ? R.err("nginx version: nginx/1.30.6", 0) : x.args.includes("-t") ? R.err(["nginx: the configuration file /etc/nginx/nginx.conf syntax is ok", "nginx: configuration file /etc/nginx/nginx.conf test is successful"], 0) : R.err(`${O.date.nginx(H.now())} [emerg] 40#40: bind() to 0.0.0.0:80 failed (98: Address in use)`, 1));
  C.python3 = C.python = (x) => {
    if (x.args.includes("--version") || x.args.includes("-V")) return R.ok("Python 3.12.16");
    if (x.args[0] === "-c") return R.ok();
    return R.ok();
  };
  C.apk = (x) => {
    if (x.args[0] === "add") { const pk = x.args.slice(1).filter((a) => !a.startsWith("-")); return R.ok([`fetch https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/APKINDEX.tar.gz`, `fetch https://dl-cdn.alpinelinux.org/alpine/v3.22/community/x86_64/APKINDEX.tar.gz`].concat(pk.map((p, k) => `(${k + 1}/${pk.length}) Installing ${p} (1.0.0-r0)`)).concat([`OK: ${12 + pk.length * 2} MiB in ${16 + pk.length} packages`])); }
    return R.ok();
  };
  C.pip = C.pip3 = () => R.ok(["Successfully installed (simulé)"]);
  C.adduser = function (x) {
    const { o, ops } = SIM.options(x.args, ["u", "G", "s", "h", "g"]);
    const nom = ops[0];
    if (!nom) return R.err("adduser: missing user name", 1);
    const p = x.fs.lire("/etc/passwd");
    if (p.contenu.split("\n").some((l) => l.split(":")[0] === nom)) return R.err(`adduser: user '${nom}' in use`, 1);
    const uid = o.u ? parseInt(o.u, 10) : 1000;
    let e = x.fs.ecrire("/etc/passwd", `${nom}:x:${uid}:${uid}::/home/${nom}:/bin/sh\n`, { ajout: true });
    if (e) return R.err(`adduser: /etc/passwd: ${MSG[e]}`, 1);
    x.fs.ecrire("/etc/group", `${nom}:x:${uid}:\n`, { ajout: true });
    x.fs.ecrire("/etc/shadow", `${nom}:!:20000:0:99999:7:::\n`, { ajout: true });
    x.fs.mkdir(`/home/${nom}`, { parents: true, uid, gid: uid });
    return R.ok();
  };
  C.useradd = (x) => C.adduser({ ...x, args: x.args.map((a) => (a === "-m" || a === "-r" ? "-D" : a)) });
  C.addgroup = C.groupadd = () => R.ok();
  C.wc = SIM.UNIX.wc;
  C.wget = function (x) {
    const { o, ops } = SIM.options(x.args, ["O", "T", "U", "header"]);
    const url = ops.find((a) => /^https?:\/\//.test(a)) || ops[0] || "";
    const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) return R.err(`wget: bad address '${url}'`, 1);
    const c = ctn(x); const mot = c.moteur || courant;
    const res = mot.resoudre(c, m[1]);
    if (!res) return R.err(`wget: bad address '${m[1]}'`, 1);
    const port = m[2] || (url.startsWith("https") ? "443" : "80");
    const dest = res.cible;
    const joignable = dest && (dest === c || Object.keys(dest.reseaux).some((n) => c.reseaux[n] && c.reseaux[n].ip && dest.reseaux[n].ip));
    const rep = joignable ? (res.servir ? res.servir({ port, chemin: m[3] || "/", agent: "Wget", de: (Object.values(c.reseaux)[0] || {}).ip }) : mot.servir(dest, { port, chemin: m[3] || "/", agent: "Wget", de: (Object.values(c.reseaux)[0] || {}).ip })) : res.servir ? res.servir({ port, chemin: m[3] || "/" }) : null;
    if (!rep) { const d = (parseInt(o.T || "5", 10) || 5) * 1000; H.avancer(d); return { l: [{ pause: d }, { t: "wget: download timed out", e: true }], code: 1 }; }
    if (rep.refus) return R.err(`wget: can't connect to remote host (${res.ip}): Connection refused`, 1);
    if (rep.code >= 400) return R.err(`wget: server returned error: HTTP/1.1 ${rep.code} ${{ 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 503: "Service Unavailable" }[rep.code] || "Error"}`, 1);
    const corps = rep.corps.replace(/\n$/, "").split("\n");
    if (o.O === "-" || o.O === "/dev/stdout") return R.ok(corps.map((t) => ({ t })).concat(o.q ? [] : []));
    const fichier = o.O || chemin.base((m[3] || "/").split("?")[0]) || "index.html";
    x.fs.ecrire(chemin.norm(fichier, x.sh.cwd), rep.corps);
    return o.q ? R.ok() : R.err([`Connecting to ${m[1]}${m[2] ? ":" + m[2] : ""} (${res.ip}:${port})`, `saving to '${fichier}'`, `${fichier}            100% |********************************|   ${rep.corps.length}  0:00:00 ETA`, `'${fichier}' saved`], 0);
  };
  C.nslookup = function (x) {
    const nom = x.args.filter((a) => !a.startsWith("-"))[0];
    const c = ctn(x);
    const mo = c.moteur || courant;
    const surReseauUtil = c.pod || Object.keys(c.reseaux).some((n) => mo.reseaux[n] && !mo.reseaux[n].defaut);
    const serveur = surReseauUtil ? "127.0.0.11" : "10.255.255.254";
    const res = mo.resoudre(c, nom);
    const tete = [`Server:\t\t${serveur}`, `Address:\t${serveur}:53`, ""];
    if (!res) return { l: tete.map((t) => ({ t })).concat([{ t: `** server can't find ${nom}: NXDOMAIN`, e: true }, { t: "" }, { t: `** server can't find ${nom}: NXDOMAIN`, e: true }, { t: "" }]), code: 1 };
    return R.ok(tete.concat(["Non-authoritative answer:", "", "Non-authoritative answer:", `Name:\t${nom}`, `Address: ${res.ip}`, ""]));
  };
  C.ping = function (x) {
    const nom = x.args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a))[0];
    const res = (ctn(x).moteur || courant).resoudre(ctn(x), nom);
    if (!res) return R.err(`ping: bad address '${nom}'`, 1);
    const caps = capsEffectives(ctn(x));
    if (!caps.has("NET_RAW")) return R.err("ping: permission denied (are you root?)", 1);
    return R.ok([`PING ${nom} (${res.ip}): 56 data bytes`, `64 bytes from ${res.ip}: seq=0 ttl=64 time=0.081 ms`, "", `--- ${nom} ping statistics ---`, "1 packets transmitted, 1 packets received, 0% packet loss", "round-trip min/avg/max = 0.081/0.081/0.081 ms"]);
  };
  C.trivy = function (x) {
    const cible = x.args.filter((a) => !a.startsWith("-") && !/^(HIGH|CRITICAL|LOW|MEDIUM|UNKNOWN)/.test(a) && a !== "image")[0] || "";
    const r = Moteur.ref(cible);
    const conn = { "alpine:3.22": [0, 0, 0], "httpd:2.4": [54, 53, 1], "nginx:stable": [31, 29, 2], "php:8.4-apache": [62, 58, 4], "python:3.12-alpine": [0, 0, 0], "mariadb:11.4": [9, 9, 0], "busybox:1.37": [0, 0, 0] }[r.ref] || [3, 3, 0];
    const famille = (BASES[r.repo] || {}).famille || "alpine";
    const os = { alpine: "alpine 3.22.2", alpine324: "alpine 3.24.3", debian: "debian 13.1", ubuntu: "ubuntu 24.04", busybox: "busybox" }[famille];
    return R.ok(["", `${r.ref} (${os})`, "=".repeat(r.ref.length + os.length + 3), `Total: ${conn[0]} (HIGH: ${conn[1]}, CRITICAL: ${conn[2]})`, ""].concat(conn[0] ? ["┌────────────────┬────────────────┬──────────┬──────────┐", "│    Library     │ Vulnerability  │ Severity │  Status  │", "├────────────────┼────────────────┼──────────┼──────────┤", "│ libexpat1      │ CVE-2026-xxxxx │ HIGH     │ affected │", "└────────────────┴────────────────┴──────────┴──────────┘", `(simulateur : tableau abrégé, ${conn[0]} lignes en vrai)`] : []));
  };

  /* ------------------------------------------------------- commandes de l'hôte */
  const HO = (D.commandesHote = {});
  HO.docker = D.docker;
  HO.ps = function (x) {
    const { o } = SIM.options(x.args, ["o", "p"]);
    const procs = [{ pid: 1, cmd: "/sbin/init", court: "systemd" }, { pid: 812, cmd: "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock", court: "dockerd" }, { pid: 840, cmd: "/usr/bin/containerd", court: "containerd" }];
    courant.conteneurs.filter((c) => c.etat === "running").forEach((c) => courant.processus(c).forEach((p) => procs.push({ pid: p.pidHote, cmd: p.cmd, court: p.cmd.split(" ")[0].replace(/:$/, "").replace(/^.*\//, ""), uid: p.uid })));
    (SIM.processusHote ? SIM.processusHote() : []).forEach((p) => procs.push(p));
    let liste = procs;
    if (o.p) { const pids = String(o.p).split(",").map(Number); liste = procs.filter((p) => pids.includes(p.pid)); }
    if (o.o) {
      const cols = o.o.split(",");
      const tete = cols.map((c) => ({ pid: O.padG("PID", 7), cmd: "CMD", args: "COMMAND", comm: "COMMAND", user: O.pad("USER", 8), uid: O.padG("UID", 5) }[c] || c.toUpperCase())).join(" ");
      const r = R.ok([tete].concat(liste.map((p) => cols.map((c) => ({ pid: O.padG(p.pid, 7), cmd: p.cmd, args: p.cmd, comm: p.court, user: O.pad(p.uid === 33 ? "www-data" : p.uid ? String(p.uid) : "root", 8), uid: O.padG(p.uid || 0, 5) }[c] || "")).join(" "))));
      return { l: r.l, code: liste.length ? 0 : 1 };
    }
    if (x.args.some((a) => /aux|-e|-ef/.test(a))) return R.ok(["UID          PID    PPID  C STIME TTY          TIME CMD"].concat(liste.map((p) => `${O.pad(p.uid ? String(p.uid) : "root", 8)} ${O.padG(p.pid, 7)} ${O.padG(1, 7)}  0 10:42 ?        00:00:00 ${p.cmd}`)));
    return R.ok(["    PID TTY          TIME CMD", "   1712 pts/0    00:00:00 bash", `   ${O.padG(2000 + Math.floor(Math.random() * 900), 4)} pts/0    00:00:00 ps`]);
  };
  HO.ss = function (x) {
    const ecoutes = [["127.0.0.53%lo:53", "0.0.0.0:*"], ["127.0.0.54:53", "0.0.0.0:*"]];
    courant.conteneurs.filter((c) => c.etat === "running").forEach((c) => c.ports.forEach((p) => { ecoutes.push([`${p.ip}:${p.hote}`, "0.0.0.0:*"]); if (p.ip === "0.0.0.0") ecoutes.push([`[::]:${p.hote}`, "[::]:*"]); }));
    (SIM.ecoutesHote ? SIM.ecoutesHote() : []).forEach((e) => ecoutes.push([e, "0.0.0.0:*"]));
    return R.ok(["State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port"].concat(ecoutes.map(([a, b]) => `LISTEN 0      4096   ${O.padG(a, 20)}   ${O.padG(b, 12)}   `)));
  };
  HO.capsh = function (x) {
    const a = x.args.find((v) => v.startsWith("--decode="));
    if (a) {
      const v = BigInt("0x" + a.slice(9));
      const noms = CAPS.filter((_, k) => (v >> BigInt(k)) & 1n).map((n) => "cap_" + n.toLowerCase());
      return R.ok(`0x${v.toString(16).padStart(16, "0")}=${noms.join(",")}`);
    }
    if (x.args.includes("--print")) return R.ok(["Current: =", "Bounding set =cap_chown,cap_dac_override,cap_dac_read_search,cap_fowner,cap_fsetid,cap_kill,cap_setgid,cap_setuid,cap_setpcap", "Securebits: 00/0x0/1'b0", " secure-noroot: no (unlocked)", "uid=1000(eleve) euid=1000(eleve)", "gid=1000(eleve)"]);
    return R.err("capsh: usage : capsh --decode=<masque hexadécimal> (dans ce simulateur)", 1);
  };
  // curl : vers les ports publiés de Docker, ou les redirections ajoutées par d'autres modules (port-forward, NodePort).
  SIM.requeteHote = function (hote, port, req) {
    if (SIM.resolveurs) for (const f of SIM.resolveurs) { const r = f(hote, port, req); if (r) return r; }
    if (["127.0.0.1", "localhost", "0.0.0.0"].includes(hote)) {
      const c = courant.conteneurs.find((v) => v.etat === "running" && v.ports.some((p) => String(p.hote) === String(port) && ["127.0.0.1", "0.0.0.0"].includes(p.ip)));
      if (!c) return { refus: true };
      const p = c.ports.find((v) => String(v.hote) === String(port));
      const gw = (courant.reseaux[Object.keys(c.reseaux)[0]] || {}).passerelle || "172.17.0.1";
      return courant.servir(c, { ...req, port: p.ctn, de: gw });
    }
    const c = courant.conteneurs.find((v) => v.etat === "running" && Object.values(v.reseaux).some((r) => r.ip === hote));
    if (c) return courant.servir(c, { ...req, port, de: (courant.reseaux[Object.keys(c.reseaux)[0]] || {}).passerelle });
    return null;
  };
  HO.curl = function (x) {
    const { o, ops } = SIM.options(x.args, ["o", "w", "m", "max-time", "X", "H", "A", "connect-timeout", "d", "data", "u"]);
    const url = ops[0] || "";
    const m = /^(https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!url) return R.err(["curl: try 'curl --help' or 'curl --manual' for more information"], 2);
    if (!m) return R.err(`curl: (3) URL rejected: Malformed input to a URL function`, 3);
    const hote = m[2]; const port = m[3] || (m[1] === "https://" ? "443" : "80"); const chem = m[4] || "/";
    const silencieux = o.s || o.silent; const montrerErr = o.S || o["show-error"];
    const methode = o.I || o.head ? "HEAD" : o.X || "GET";
    const ecrireW = (code) => (o.w ? [{ t: o.w.replace(/%\{http_code\}/g, code).replace(/%\{remote_ip\}/g, hote).replace(/\\n$/, ""), brut: undefined }] : []);
    // Quelques adresses d'Internet utiles aux labs (téléchargement de kubectl et de minikube).
    const web = (SIM.webExterne || {})[url.replace(/^https?:\/\//, "")];
    if (web) {
      const l = [];
      if (o.O || o["remote-name"] || o.o) {
        const nomF = o.o || chemin.base(url);
        x.fs.ecrire(chemin.norm(nomF, x.sh.cwd), "", { taille: web.taille, mode: 0o644 });
        if (!silencieux) l.push({ t: "  % Total    % Received % Xferd  Average Speed  Time    Time    Time   Current", e: true }, { t: "                                 Dload  Upload  Total   Spent   Left   Speed", e: true }, { pause: web.duree || 1500 }, { t: web.progression, e: true });
        H.avancer(web.duree || 1500);
        return { l, code: 0 };
      }
      return R.ok([{ t: web.contenu, brut: web.contenu }]);
    }
    if (!/^(\d+\.){3}\d+$/.test(hote) && hote !== "localhost" && !(SIM.dnsHote && SIM.dnsHote(hote))) {
      const l = silencieux && !montrerErr ? [] : [{ t: `curl: (6) Could not resolve host: ${hote}`, e: true }];
      return { l: ecrireW("000").concat(l), code: 6 };
    }
    const rep = SIM.requeteHote(hote, port, { methode, chemin: chem, port, agent: "curl/8.18.0" });
    if (!rep || rep.refus) {
      const cible = hote === "localhost" ? "localhost" : hote;
      if (!rep) { const d = (parseInt(o.m || o["max-time"] || o["connect-timeout"] || "5", 10) || 5) * 1000; H.avancer(d); const l = silencieux && !montrerErr ? [] : [{ t: `curl: (28) Connection timed out after ${d} milliseconds`, e: true }]; return { l: [{ pause: d }].concat(ecrireW("000"), l), code: 28 }; }
      const l = silencieux && !montrerErr ? [] : [{ t: `curl: (7) Failed to connect to ${cible} port ${port} after 0 ms: Couldn't connect to server`, e: true }];
      return { l: ecrireW("000").concat(l), code: 7 };
    }
    if ((o.f || o.fail) && rep.code >= 400) { const l = silencieux && !montrerErr ? [] : [{ t: `curl: (22) The requested URL returned error: ${rep.code}`, e: true }]; return { l: ecrireW(String(rep.code)).concat(l), code: 22 }; }
    const textes = { 200: "OK", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Temporarily Unavailable" };
    const entetes = [`HTTP/1.1 ${rep.code} ${textes[rep.code] || ""}`.trim()];
    if (rep.serveur) entetes.push(`Server: ${rep.serveur}`);
    entetes.push(`Date: ${O.date.http(H.now())}`, `Content-Type: ${rep.entetes.type}`, `Content-Length: ${rep.entetes.longueur}`);
    if (rep.modifie && /nginx|Apache/.test(rep.serveur || "")) entetes.push(`Last-Modified: ${O.date.http(rep.modifie)}`);
    entetes.push("Connection: keep-alive");
    if (/nginx/.test(rep.serveur || "")) entetes.push(`ETag: "${Math.floor((rep.modifie || 0) / 1000).toString(16)}-${rep.entetes.longueur.toString(16)}"`, "Accept-Ranges: bytes");
    entetes.push("");
    const corps = methode === "HEAD" ? [] : rep.corps.replace(/\n$/, "").split("\n");
    let l;
    if (o.o) {
      if (o.o !== "/dev/null") x.fs.ecrire(chemin.norm(o.o, x.sh.cwd), rep.corps);
      l = (o.i ? entetes : []).map((t) => ({ t }));
    } else l = (o.I || o.head ? entetes : o.i ? entetes.concat(corps) : corps).map((t) => ({ t }));
    if (!rep.corps.endsWith("\n") && !o.o && !o.I && l.length && !o.w) l[l.length - 1].brut = l[l.length - 1].t;
    return { l: l.concat(ecrireW(String(rep.code))), code: 0 };
  };
  HO.wget = function (x) {
    const { o, ops } = SIM.options(x.args, ["O", "T"]);
    const r = HO.curl({ ...x, args: ["-s"].concat(ops) });
    if (o.O === "-" || o.q) return r;
    return r;
  };
  HO.install = function (x) {
    const { o, ops } = SIM.options(x.args, ["o", "g", "m", "owner", "group", "mode"]);
    if (ops.length < 2) return R.err(["install: missing destination file operand after '" + (ops[0] || "") + "'", "Try 'install --help' for more information."], 1);
    const src = chemin.norm(ops[0], x.sh.cwd); const n = x.fs.stat(src);
    if (!n) return R.err(`install: cannot stat '${ops[0]}': No such file or directory`, 1);
    if (x.uid !== 0) return R.err(`install: cannot create regular file '${ops[1]}': Permission denied`, 1);
    let dest = chemin.norm(ops[1], x.sh.cwd); const d = x.fs.stat(dest); if (d && d.type === "d") dest += "/" + chemin.base(src);
    x.fs.ecrire(dest, n.contenu || "", { taille: n.taille, mode: o.m ? parseInt(o.m, 8) : 0o755, uid: 0, gid: 0 });
    return R.ok();
  };
  HO.sudo = (x) => { const uid = x.sh.uid; x.sh.uid = 0; try { return x.sh.lancer(x.args.filter((a) => !/^-[A-Za-z]$/.test(a)), x.stdin); } finally { x.sh.uid = uid; } };
  HO.id = (x) => R.ok("uid=1000(eleve) gid=1000(eleve) groups=1000(eleve),4(adm),27(sudo),984(docker)");
  HO.whoami = () => R.ok("eleve");
  HO.hostname = () => R.ok("lab");
  HO.history = (x) => R.ok((x.sh.historique || []).map((h, k) => `${O.padG(k + 1, 5)}  ${h}`));

  /* -------------------------------------------- identité dans un conteneur */
  SIM.idUtilisateur = function (x) {
    const c = ctn(x);
    if (!c) return "uid=1000(eleve) gid=1000(eleve) groups=1000(eleve),4(adm),27(sudo),984(docker)";
    const passwd = (x.fs.lire("/etc/passwd").contenu || "").split("\n").map((l) => l.split(":"));
    const groupes = (x.fs.lire("/etc/group").contenu || "").split("\n").map((l) => l.split(":"));
    const user = x.sh.ctx.user !== undefined ? x.sh.ctx.user : c.config.User;
    const [u, g] = String(user || "0").split(":");
    const ent = passwd.find((p) => p[0] === u || p[2] === u);
    if (!ent && !/^\d+$/.test(u)) return null;
    const uid = ent ? ent[2] : u; const gid = g || (ent ? ent[3] : u);
    const nomU = ent ? `(${ent[0]})` : ""; const grp = groupes.find((k) => k[2] === gid);
    const nomG = grp ? `(${grp[0]})` : "";
    let sup = [];
    if (ent) sup = groupes.filter((k) => (k[3] || "").split(",").includes(ent[0])).map((k) => `${k[2]}(${k[0]})`);
    const liste = x.variante === "sh" ? [`${gid}${nomG}`].concat(sup) : [...new Set([`${gid}${nomG}`].concat(sup))];
    return `uid=${uid}${nomU} gid=${gid}${nomG} groups=${liste.join(",")}`;
  };
})(typeof window !== "undefined" ? window : globalThis);
