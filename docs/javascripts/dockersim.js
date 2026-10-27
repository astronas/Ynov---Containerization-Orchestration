/* Simulateur Docker dans le navigateur, sans serveur.
 * Un moteur garde en mémoire images, conteneurs, volumes et réseaux, et répond
 * à un sous-ensemble de commandes avec le format de sortie du vrai Docker.
 * Composant : <div class="terminal-sim" data-lab="isolation"></div>
 * Le lab guidé est lu dans assets/labs/<nom>.json. */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ outils */
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));
  const now = () => Date.now();

  function duree(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 1) return "Less than a second";
    if (s < 60) return s + " seconds";
    if (s < 120) return "About a minute";
    if (s < 3600) return Math.floor(s / 60) + " minutes";
    return "About an hour";
  }

  function tableau(lignes) {
    // Alignement façon tabwriter de Docker : 3 espaces entre colonnes.
    const largeurs = [];
    lignes.forEach((l) => l.forEach((c, i) => { largeurs[i] = Math.max(largeurs[i] || 0, String(c).length); }));
    return lignes.map((l) => l.map((c, i) => (i === l.length - 1 ? String(c) : pad(c, largeurs[i] + 3))).join("")).join("\n");
  }

  function decouper(ligne) {
    // Découpe une ligne de commande en mots, en respectant les guillemets.
    const mots = []; let cur = ""; let q = null; let dans = false;
    for (const ch of ligne) {
      if (q) { if (ch === q) q = null; else cur += ch; continue; }
      if (ch === "'" || ch === '"') { q = ch; dans = true; continue; }
      if (/\s/.test(ch)) { if (cur || dans) { mots.push(cur); cur = ""; dans = false; } continue; }
      cur += ch;
    }
    if (cur || dans) mots.push(cur);
    return mots;
  }

  function separer(ligne, sep) {
    // Coupe sur un séparateur hors guillemets ("&&", ";" ou "|").
    const parts = []; let cur = ""; let q = null;
    for (let i = 0; i < ligne.length; i++) {
      const ch = ligne[i];
      if (q) { if (ch === q) q = null; cur += ch; continue; }
      if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
      if (ligne.startsWith(sep, i) && !(sep === "|" && ligne[i + 1] === "|")) { parts.push(cur); cur = ""; i += sep.length - 1; continue; }
      cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function taille(v) {
    // "128m" -> octets
    const m = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(String(v).trim());
    if (!m) return NaN;
    const mult = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
    return Math.round(parseFloat(m[1]) * mult);
  }
  const mio = (o) => (o / 1024 ** 2).toFixed(o < 10 * 1024 ** 2 ? 3 : 2).replace(/\.?0+$/, "") + "MiB";

  /* --------------------------------------------------------- capabilities */
  const CAPS = { CHOWN: 0, DAC_OVERRIDE: 1, DAC_READ_SEARCH: 2, FOWNER: 3, FSETID: 4, KILL: 5, SETGID: 6, SETUID: 7,
    SETPCAP: 8, LINUX_IMMUTABLE: 9, NET_BIND_SERVICE: 10, NET_BROADCAST: 11, NET_ADMIN: 12, NET_RAW: 13, IPC_LOCK: 14,
    IPC_OWNER: 15, SYS_MODULE: 16, SYS_RAWIO: 17, SYS_CHROOT: 18, SYS_PTRACE: 19, SYS_PACCT: 20, SYS_ADMIN: 21,
    SYS_BOOT: 22, SYS_NICE: 23, SYS_RESOURCE: 24, SYS_TIME: 25, SYS_TTY_CONFIG: 26, MKNOD: 27, LEASE: 28,
    AUDIT_WRITE: 29, AUDIT_CONTROL: 30, SETFCAP: 31 };
  const DEFAUT = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "NET_BIND_SERVICE",
    "NET_RAW", "SYS_CHROOT", "MKNOD", "AUDIT_WRITE", "SETFCAP"];
  const nomCap = (c) => c.toUpperCase().replace(/^CAP_/, "");

  function capsEffectives(c) {
    let set = new Set(DEFAUT);
    if (c.privileged) set = new Set(Object.keys(CAPS));
    c.capDrop.forEach((x) => { if (x === "ALL") set.clear(); else set.delete(x); });
    c.capAdd.forEach((x) => { if (x === "ALL") Object.keys(CAPS).forEach((k) => set.add(k)); else set.add(x); });
    return set;
  }
  function capMasque(set, racine) {
    if (!racine) return "0000000000000000";
    let v = 0n;
    set.forEach((k) => { v |= 1n << BigInt(CAPS[k]); });
    return v.toString(16).padStart(16, "0");
  }

  /* ---------------------------------------------------------------- images */
  const CATALOGUE = {
    "nginx": { tags: ["stable", "latest", "1.27", "1.28", "alpine"], cmd: "nginx -g daemon off;", cmdAff: '"/docker-entrypoint.…"',
      os: 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"', workers: { user: "101", n: 4 }, mem: 7.4, taille: "192MB",
      logs: ["/docker-entrypoint.sh: Configuration complete; ready for start up", "start worker processes"] },
    "httpd": { tags: ["2.4", "latest", "alpine"], cmd: "httpd -DFOREGROUND", cmdAff: '"httpd-foreground"',
      os: 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"', workers: { user: "www-data", n: 3, apache: true }, mem: 11.8, taille: "148MB",
      logs: ["AH00558: httpd: Could not reliably determine the server's fully qualified domain name", "AH00094: Command line: 'httpd -D FOREGROUND'"] },
    "alpine": { tags: ["3.22", "latest", "3.21"], cmd: "/bin/sh", cmdAff: '"/bin/sh"', os: 'PRETTY_NAME="Alpine Linux v3.22"', mem: 0.5, taille: "8.3MB" },
    "busybox": { tags: ["1.37", "latest"], cmd: "sh", cmdAff: '"sh"', os: 'PRETTY_NAME="BusyBox"', mem: 0.4, taille: "4.4MB" },
    "hello-world": { tags: ["latest"], cmd: "/hello", cmdAff: '"/hello"', os: "", mem: 0.1, taille: "10.1kB" },
    "mariadb": { tags: ["11.4", "latest"], cmd: "mariadbd", cmdAff: '"docker-entrypoint.s…"', os: 'PRETTY_NAME="Ubuntu 24.04 LTS"', mem: 82, taille: "407MB",
      logs: ["[Note] mariadbd: ready for connections."], env: ["MARIADB_ROOT_PASSWORD", "MARIADB_RANDOM_ROOT_PASSWORD", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD"] },
    "python": { tags: ["3.12-alpine", "3.12", "latest"], cmd: "python3", cmdAff: '"python3"', os: 'PRETTY_NAME="Alpine Linux v3.22"', mem: 9, taille: "58MB" },
  };
  function refImage(nom) {
    let n = nom.replace(/^docker\.io\/(library\/)?/, "");
    if (!n.includes(":")) n += ":latest";
    const [repo, tag] = n.split(":");
    return { repo, tag, ref: repo + ":" + tag, connu: !!CATALOGUE[repo] && CATALOGUE[repo].tags.includes(tag) };
  }

  const HELLO = `
Hello from Docker!
This message shows that your installation appears to be working correctly.

To generate this message, Docker took the following steps:
 1. The Docker client contacted the Docker daemon.
 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.
    (amd64)
 3. The Docker daemon created a new container from that image which runs the
    executable that produces the output you are currently reading.
 4. The Docker daemon streamed that output to the Docker client, which sent it
    to your terminal.`;

  const NGINX_HTML = "<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n[...]";
  const HTTPD_HTML = "<html><body><h1>It works!</h1></body></html>";

  /* ----------------------------------------------------------------- moteur */
  class Moteur {
    constructor() { this.reinitialiser(); }

    reinitialiser() {
      this.images = {};        // ref -> {id, cree}
      this.conteneurs = [];
      this.volumes = {};
      this.reseaux = { bridge: { id: hex(12), driver: "bridge" }, host: { id: hex(12), driver: "host" }, none: { id: hex(12), driver: "null" } };
      this.pidHote = 41200;
    }

    trouver(nom) {
      return this.conteneurs.find((c) => c.nom === nom || c.id.startsWith(nom)) || null;
    }
    portsPris() {
      const p = new Set();
      this.conteneurs.filter((c) => c.etat === "running").forEach((c) => c.ports.forEach((x) => p.add(x.ip + ":" + x.hote)));
      return p;
    }

    tirer(ref, sortie) {
      const r = refImage(ref);
      if (!r.connu) {
        sortie.push(`docker: Error response from daemon: pull access denied for ${r.repo}, repository does not exist or may require 'docker login'.`);
        sortie.push("(dans ce simulateur, images disponibles : " + Object.keys(CATALOGUE).join(", ") + ")");
        return null;
      }
      if (!this.images[r.ref]) {
        sortie.push(`Unable to find image '${r.ref}' locally`);
        sortie.push(`${r.tag}: Pulling from library/${r.repo}`);
        for (let i = 0; i < (r.repo === "hello-world" ? 1 : 3); i++) sortie.push(`${hex(12)}: Pull complete`);
        sortie.push(`Digest: sha256:${hex(64)}`);
        sortie.push(`Status: Downloaded newer image for ${r.ref}`);
        this.images[r.ref] = { id: hex(12), cree: now() };
      }
      return r;
    }

    processus(c) {
      // Programmes du conteneur, vus de l'intérieur (pid) et de l'hôte (pidHote).
      const img = CATALOGUE[c.repo];
      const liste = [{ pid: 1, pidHote: c.pidHote, user: c.user || "root", cmd: c.cmd }];
      if (img.workers && c.etat === "running") {
        const apacheSansCaps = img.workers.apache && !(capsEffectives(c).has("SETUID") && capsEffectives(c).has("SETGID"));
        const uw = c.user && c.user !== "root" ? c.user : (apacheSansCaps ? "root" : img.workers.user);
        const nom = c.repo === "nginx" ? "nginx: worker process" : c.cmd;
        for (let i = 0; i < img.workers.n; i++) liste.push({ pid: 29 + i, pidHote: c.pidHote + 40 + i, user: uw, cmd: nom });
        if (c.repo === "nginx") liste[0].cmd = "nginx: master process nginx -g daemon off;";
      }
      return liste.concat(c.extra || []);
    }

    /* --------------------------------------------------- docker run */
    run(args, sortie) {
      const o = { d: false, rm: false, nom: null, ports: [], memoire: 0, cpus: 0, pids: 0, capAdd: [], capDrop: [], user: null,
        env: [], vols: [], privileged: false, readOnly: false, reseau: "bridge" };
      let i = 0;
      const val = () => { const a = args[i]; if (a.includes("=")) return a.split(/=(.*)/s)[1]; i++; return args[i]; };
      for (; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith("-")) break;
        const cle = a.split("=")[0];
        if (cle === "-d" || cle === "--detach") o.d = true;
        else if (cle === "--rm") o.rm = true;
        else if (/^-[it]+$/.test(cle) || cle === "--interactive" || cle === "--tty") { /* ignoré */ }
        else if (cle === "-dit" || cle === "-itd" || cle === "-di" || cle === "-id") o.d = true;
        else if (cle === "--name") o.nom = val();
        else if (cle === "-p" || cle === "--publish") {
          const p = val().split(":");
          const [ip, hote, ctn] = p.length === 3 ? p : ["0.0.0.0", p[0], p[1]];
          o.ports.push({ ip, hote, ctn: (ctn || "").replace(/\/tcp$/, "") });
        } else if (cle === "-m" || cle === "--memory") o.memoire = taille(val());
        else if (cle === "--cpus") o.cpus = parseFloat(val());
        else if (cle === "--pids-limit") o.pids = parseInt(val(), 10);
        else if (cle === "--cap-add") o.capAdd.push(nomCap(val()));
        else if (cle === "--cap-drop") o.capDrop.push(nomCap(val()));
        else if (cle === "-u" || cle === "--user") o.user = val();
        else if (cle === "-e" || cle === "--env") o.env.push(val());
        else if (cle === "-v" || cle === "--volume") o.vols.push(val());
        else if (cle === "--network" || cle === "--net") o.reseau = val();
        else if (cle === "--privileged") o.privileged = true;
        else if (cle === "--read-only") o.readOnly = true;
        else if (cle === "--security-opt" || cle === "--restart" || cle === "--tmpfs" || cle === "-w" || cle === "--workdir" || cle === "--hostname") val();
        else { sortie.push(`unknown flag: ${cle}`); sortie.push("See 'docker run --help'."); return 125; }
      }
      const image = args[i];
      if (!image) { sortie.push('"docker run" requires at least 1 argument.'); return 1; }
      const cmdUtil = args.slice(i + 1);

      if (o.nom && this.trouver(o.nom) && this.trouver(o.nom).nom === o.nom) {
        const c = this.trouver(o.nom);
        sortie.push(`docker: Error response from daemon: Conflict. The container name "/${o.nom}" is already in use by container "${c.idLong}". You have to remove (or rename) that container to be able to reuse that name.`);
        return 125;
      }
      if (o.memoire && o.memoire < 6 * 1024 * 1024) { sortie.push("docker: Error response from daemon: Minimum memory limit allowed is 6MB."); return 125; }
      const r = this.tirer(image, sortie);
      if (!r) return 125;
      const pris = this.portsPris();
      for (const p of o.ports) {
        if (pris.has(p.ip + ":" + p.hote) || pris.has("0.0.0.0:" + p.hote)) {
          sortie.push(`docker: Error response from daemon: failed to set up container networking: Bind for ${p.ip}:${p.hote} failed: port is already allocated`);
          return 125;
        }
      }
      if (r.repo === "mariadb" && !o.env.some((e) => CATALOGUE.mariadb.env.some((k) => e.startsWith(k)))) {
        // MariaDB refuse de démarrer sans mot de passe root : comme en vrai, il s'arrête aussitôt.
      }

      const idLong = hex(64);
      const noms = ["nifty", "brave", "eager", "jolly", "quirky", "serene", "zen", "vibrant"];
      const savants = ["turing", "hopper", "lovelace", "torvalds", "curie", "noether", "shannon", "ritchie"];
      const c = {
        id: idLong.slice(0, 12), idLong, nom: o.nom || noms[Math.floor(Math.random() * 8)] + "_" + savants[Math.floor(Math.random() * 8)],
        repo: r.repo, image: image, ref: r.ref, cmd: cmdUtil.length ? cmdUtil.join(" ") : CATALOGUE[r.repo].cmd,
        cmdAff: cmdUtil.length ? '"' + cmdUtil.join(" ").slice(0, 18) + (cmdUtil.join(" ").length > 18 ? "…" : "") + '"' : CATALOGUE[r.repo].cmdAff,
        cree: now(), demarre: now(), etat: "running", code: 0, oom: false, finit: null, ports: o.ports, memoire: o.memoire,
        cpus: o.cpus, pids: o.pids, capAdd: o.capAdd, capDrop: o.capDrop, user: o.user, env: o.env, vols: o.vols,
        privileged: o.privileged, readOnly: o.readOnly, rm: o.rm, reseau: o.reseau, fichiers: {}, logs: [], extra: [],
        pidHote: (this.pidHote += 137),
      };
      o.vols.forEach((v) => { const nomV = v.split(":")[0]; if (!nomV.startsWith("/") && !this.volumes[nomV]) this.volumes[nomV] = { cree: now(), fichiers: {} }; });
      this.conteneurs.push(c);

      // Ce que fait le programme principal au démarrage.
      const img = CATALOGUE[r.repo];
      if (img.logs) c.logs.push(...img.logs);
      if (img.workers && img.workers.apache && !(capsEffectives(c).has("SETUID") && capsEffectives(c).has("SETGID")) && !o.user)
        c.logs.push("[unixd:alert] (1)Operation not permitted: AH02156: setgid: unable to set group id to Group 33");
      if (r.repo === "mariadb" && !o.env.some((e) => img.env.some((k) => e.startsWith(k)))) {
        c.logs.push("[ERROR] [Entrypoint]: Database is uninitialized and password option is not specified",
          "\tYou need to specify one of MARIADB_ROOT_PASSWORD, MARIADB_ROOT_PASSWORD_HASH, MARIADB_ALLOW_EMPTY_ROOT_PASSWORD and MARIADB_RANDOM_ROOT_PASSWORD");
        this.arreter(c, 1);
      }

      let sortieProg = [];
      if (c.etat === "running") {
        const prog = cmdUtil.length ? cmdUtil.join(" ") : (r.repo === "hello-world" ? "/hello" : null);
        if (r.repo === "hello-world" && !cmdUtil.length) { sortieProg = HELLO.split("\n"); this.arreter(c, 0); }
        else if (prog && !img.workers && /^(sleep\s+\d+|tail\s+-f|sleep\s+infinity)/.test(prog)) {
          // programme long : le conteneur reste allumé
        } else if (prog && !img.workers) {
          const res = new Shell(this, c).executer(prog);
          sortieProg = res.sortie; this.arreter(c, res.code, res.oom);
        } else if (["alpine", "busybox", "python"].includes(r.repo) && !cmdUtil.length) {
          // Un shell sans terminal interactif s'arrête aussitôt.
          this.arreter(c, 0);
        }
      }
      c.logs.push(...sortieProg);
      if (o.d) sortie.push(idLong);
      else sortie.push(...sortieProg);
      if (o.rm && c.etat !== "running") this.conteneurs = this.conteneurs.filter((x) => x !== c);
      return o.d ? 0 : c.code;
    }

    arreter(c, code, oom) {
      c.etat = "exited"; c.code = code; c.oom = !!oom; c.finit = now();
    }

    /* --------------------------------------------------- docker ps */
    ps(args, sortie) {
      let tous = false, filtre = null, format = null, quiet = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-a" || a === "--all") tous = true;
        else if (a === "-q" || a === "--quiet") quiet = true;
        else if (a === "-aq" || a === "-qa") { tous = true; quiet = true; }
        else if (a === "--filter" || a === "-f") filtre = args[++i];
        else if (a.startsWith("--filter=")) filtre = a.slice(9);
        else if (a === "--format") format = args[++i];
        else if (a.startsWith("--format=")) format = a.slice(9);
      }
      let liste = this.conteneurs.filter((c) => tous || c.etat === "running");
      if (filtre) {
        const [k, v] = filtre.split("=");
        if (k === "name") liste = liste.filter((c) => c.nom.includes(v));
        else if (k === "status") liste = liste.filter((c) => (v === "exited" ? c.etat === "exited" : c.etat === v));
        else if (k === "ancestor") liste = liste.filter((c) => c.repo === refImage(v).repo);
      }
      liste = liste.slice().reverse();
      if (quiet) { liste.forEach((c) => sortie.push(c.id)); return 0; }
      const champs = (c) => ({
        ID: c.id, Image: c.image, Command: c.cmdAff, CreatedAt: new Date(c.cree).toISOString(), RunningFor: duree(now() - c.cree) + " ago",
        Status: this.statut(c), Ports: this.ports(c), Names: c.nom, State: c.etat,
      });
      if (format) sortie.push(...formater(format, liste.map(champs)));
      else sortie.push(tableau([["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"]]
        .concat(liste.map((c) => { const f = champs(c); return [f.ID, f.Image, f.Command, f.RunningFor, f.Status, f.Ports, f.Names]; }))));
      return 0;
    }
    statut(c) {
      return c.etat === "running" ? "Up " + duree(now() - c.demarre) : `Exited (${c.code}) ${duree(now() - c.finit)} ago`;
    }
    ports(c) {
      return c.ports.map((p) => (c.etat === "running" ? `${p.ip}:${p.hote}->${p.ctn}/tcp` : "")).filter(Boolean).join(", ")
        || ({ nginx: "80/tcp", httpd: "80/tcp", mariadb: "3306/tcp" }[c.repo] && c.etat === "running" ? { nginx: "80/tcp", httpd: "80/tcp", mariadb: "3306/tcp" }[c.repo] : "");
    }

    /* --------------------------------------------------- docker top */
    top(args, sortie) {
      const c = this.trouver(args[0] || "");
      if (!c) { sortie.push(`Error response from daemon: No such container: ${args[0] || ""}`); return 1; }
      if (c.etat !== "running") { sortie.push(`Error response from daemon: container ${c.idLong} is not running`); return 1; }
      const o = args.indexOf("-o") >= 0 ? args[args.indexOf("-o") + 1].split(",") : null;
      if (o && !o.includes("pid")) { sortie.push("Error response from daemon: Couldn't find PID field in ps output"); return 1; }
      const procs = this.processus(c);
      if (!o) {
        sortie.push(tableau([["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"]]
          .concat(procs.map((p, k) => [p.user, p.pidHote, k ? c.pidHote : c.pidHote - 20, "0", "10:42", "?", "00:00:00", p.cmd]))));
      } else {
        const col = { user: (p) => p.user, uid: (p) => (p.user === "root" ? "0" : p.user), pid: (p) => p.pidHote, cmd: (p) => p.cmd, args: (p) => p.cmd, comm: (p) => p.cmd.split(" ")[0] };
        sortie.push(tableau([o.map((x) => x.toUpperCase())].concat(procs.map((p) => o.map((x) => (col[x] ? col[x](p) : "-"))))));
      }
      return 0;
    }

    /* --------------------------------------------------- docker inspect */
    inspect(args, sortie) {
      let format = null; const noms = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-f" || args[i] === "--format") format = args[++i];
        else if (args[i].startsWith("--format=")) format = args[i].slice(9);
        else if (args[i] === "--type") i++;
        else noms.push(args[i]);
      }
      let code = 0;
      for (const n of noms) {
        const c = this.trouver(n);
        if (!c) {
          const img = this.images[refImage(n).ref];
          if (img) { sortie.push(format ? formater(format, [{ Id: "sha256:" + img.id, Config: { User: "", Cmd: [CATALOGUE[refImage(n).repo].cmd] } }]).join("\n") : `[{ "Id": "sha256:${img.id}…", "RepoTags": ["${refImage(n).ref}"] }]`); continue; }
          sortie.push(`Error: No such object: ${n}`); code = 1; continue;
        }
        const d = {
          Id: c.idLong, Name: "/" + c.nom, Image: "sha256:" + (this.images[c.ref] || { id: hex(12) }).id,
          State: { Status: c.etat, Running: c.etat === "running", ExitCode: c.code, OOMKilled: c.oom, Pid: c.etat === "running" ? c.pidHote : 0 },
          Config: { Hostname: c.id, User: c.user || "", Image: c.image, Cmd: c.cmd.split(" "), Env: c.env },
          HostConfig: { Memory: c.memoire, NanoCpus: Math.round(c.cpus * 1e9), PidsLimit: c.pids || null, CapAdd: c.capAdd.length ? c.capAdd.map((x) => "CAP_" + x) : null,
            CapDrop: c.capDrop.length ? c.capDrop : null, Privileged: c.privileged, ReadonlyRootfs: c.readOnly, NetworkMode: c.reseau,
            PortBindings: Object.fromEntries(c.ports.map((p) => [p.ctn + "/tcp", [{ HostIp: p.ip, HostPort: p.hote }]])) },
          Mounts: c.vols.map((v) => { const [src, dst, mode] = v.split(":"); return { Type: src.startsWith("/") ? "bind" : "volume", Source: src, Destination: dst, RW: mode !== "ro" }; }),
        };
        if (format) sortie.push(...formater(format, [d]));
        else sortie.push(JSON.stringify([d], null, 4));
      }
      return code;
    }

    /* --------------------------------------------------- docker stats */
    stats(args, sortie) {
      const fmt = args.indexOf("--format") >= 0 ? args[args.indexOf("--format") + 1] : null;
      const noms = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "--format");
      const liste = (noms.length ? noms.map((n) => this.trouver(n)).filter(Boolean) : this.conteneurs).filter((c) => c.etat === "running");
      const lignes = liste.map((c) => {
        const img = CATALOGUE[c.repo];
        const lim = c.memoire || 7.602 * 1024 ** 3;
        const conso = img.mem * 1024 ** 2;
        return { ID: c.id, Name: c.nom, CPUPerc: "0.00%", MemUsage: `${mio(conso)} / ${c.memoire ? mio(lim) : "7.602GiB"}`,
          MemPerc: ((conso / lim) * 100).toFixed(2) + "%", PIDs: String(this.processus(c).length), NetIO: "1.2kB / 0B", BlockIO: "0B / 4.1kB" };
      });
      if (fmt) sortie.push(...formater(fmt, lignes));
      else sortie.push(tableau([["CONTAINER ID", "NAME", "CPU %", "MEM USAGE / LIMIT", "MEM %", "NET I/O", "BLOCK I/O", "PIDS"]]
        .concat(lignes.map((l) => [l.ID, l.Name, l.CPUPerc, l.MemUsage, l.MemPerc, l.NetIO, l.BlockIO, l.PIDs]))));
      if (!args.includes("--no-stream")) sortie.push("(le simulateur affiche une seule mesure : ajoute --no-stream)");
      return 0;
    }
  }

  /* -------------------------------------------- gabarits --format de Docker */
  function formater(gabarit, objets) {
    let g = gabarit.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
    const table = /^table\s+/.test(g);
    if (table) g = g.replace(/^table\s+/, "");
    const lire = (obj, chemin) => chemin.split(".").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const rendre = (obj) => g.replace(/\{\{\s*json\s+\.([\w.]*)\s*\}\}/g, (_, p) => JSON.stringify(p ? lire(obj, p) : obj))
      .replace(/\{\{\s*\.([\w.]+)\s*\}\}/g, (_, p) => { const v = lire(obj, p); return v === null || v === undefined ? "<no value>" : Array.isArray(v) ? "[" + v.join(" ") + "]" : String(v); })
      .replace(/\{\{range[^}]*\}\}|\{\{end\}\}/g, "");
    const lignes = objets.map(rendre);
    if (!table) return lignes;
    const entetes = { ID: "CONTAINER ID", Names: "NAMES", Name: "NAME", Image: "IMAGE", Status: "STATUS", Ports: "PORTS", Command: "COMMAND",
      RunningFor: "CREATED", State: "STATE", CPUPerc: "CPU %", MemUsage: "MEM USAGE / LIMIT", MemPerc: "MEM %", PIDs: "PIDS" };
    const tete = g.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, k) => entetes[k] || k.toUpperCase());
    return tableau([tete].concat(lignes).map((l) => l.split("\t"))).split("\n");
  }

  /* --------------------------------------------- le shell dans un conteneur */
  class Shell {
    constructor(moteur, c) { this.m = moteur; this.c = c; }

    executer(ligne) {
      const sortie = []; let code = 0; let oom = false;
      if (/^\s*for\b/.test(ligne)) { const r = this.commande(decouper(ligne), null); return { sortie: r.sortie, code: r.code, oom: false }; }
      for (const morceau of separer(ligne, ";").flatMap((p) => separer(p, "&&"))) {
        const etapes = separer(morceau, "|");
        let flux = null;
        for (const e of etapes) {
          const r = this.commande(decouper(e), flux);
          flux = r.sortie; code = r.code; if (r.oom) oom = true;
          if (oom) break;
        }
        sortie.push(...(flux || []));
        if (oom) { code = 137; break; }
      }
      return { sortie, code, oom };
    }

    fichier(chemin) {
      const c = this.c; const img = CATALOGUE[c.repo];
      const racine = (c.user || "root") === "root";
      const caps = capsEffectives(c);
      const f = {
        "/proc/1/cmdline": (c.repo === "nginx" && c.cmd === CATALOGUE.nginx.cmd ? "nginx: master process nginx -g daemon off;" : c.cmd),
        "/proc/1/status": `Name:\t${c.cmd.split(" ")[0].replace(/:$/, "")}\nState:\tS (sleeping)\nPid:\t1\nUid:\t${racine ? 0 : 1000}\t${racine ? 0 : 1000}\nCapInh:\t0000000000000000\nCapPrm:\t${capMasque(caps, racine)}\nCapEff:\t${capMasque(caps, racine)}\nCapBnd:\t${capMasque(caps, true)}\nNoNewPrivs:\t0\nSeccomp:\t${c.privileged ? 0 : 2}`,
        "/sys/fs/cgroup/memory.max": c.memoire ? String(c.memoire) : "max",
        "/sys/fs/cgroup/pids.max": c.pids ? String(c.pids) : "max",
        "/sys/fs/cgroup/cpu.max": c.cpus ? `${Math.round(c.cpus * 100000)} 100000` : "max 100000",
        "/etc/os-release": img.os,
        "/etc/hostname": c.id,
      };
      if (chemin in f) return f[chemin];
      if (chemin in c.fichiers) return c.fichiers[chemin];
      return null;
    }

    commande(mots, entree) {
      const [cmd, ...a] = mots;
      const c = this.c; const out = [];
      const ok = (lignes, code = 0) => ({ sortie: [].concat(lignes).filter((x) => x !== undefined), code });
      switch (cmd) {
        case undefined: return ok([]);
        case "sh": case "bash": case "/bin/sh": case "/bin/bash":
          if (a[0] === "-c") { const r = this.executer(a.slice(1).join(" ")); return { sortie: r.sortie, code: r.code, oom: r.oom }; }
          return ok([]);
        case "echo": return ok(a.join(" ").replace(/\$\(date\)/, new Date().toString()));
        case "hostname": return ok(c.id);
        case "whoami": return ok(c.user && c.user !== "root" ? (/^\d+$/.test(c.user) ? `whoami: unknown uid ${c.user}` : c.user) : "root");
        case "id": {
          if (!c.user || c.user === "root") return ok("uid=0(root) gid=0(root) groups=0(root)");
          const [u, g] = c.user.split(":");
          return ok(/^\d+$/.test(u) ? `uid=${u} gid=${g || u} groups=${g || u}` : `uid=33(${u}) gid=33(${u}) groups=33(${u})`);
        }
        case "uname": return ok(a.includes("-r") ? "6.8.0-60-generic" : a.includes("-a") ? `Linux ${c.id} 6.8.0-60-generic #1 SMP x86_64 GNU/Linux` : "Linux");
        case "nproc": return ok(c.cpus ? String(Math.max(1, Math.ceil(c.cpus))) : "4");
        case "sleep": return ok([]);
        case "pwd": return ok("/");
        case "ls": {
          const cible = a.filter((x) => !x.startsWith("-"))[0] || "/";
          if (cible === "/proc") return ok(this.m.processus(c).map((p) => String(p.pid)).concat(["acpi", "cpuinfo", "meminfo", "self"]));
          if (cible === "/") return ok("bin   dev   etc   home  lib   media mnt   opt   proc  root  run   sbin  srv   sys   tmp   usr   var");
          const fs = Object.keys(c.fichiers).filter((f) => f.startsWith(cible.replace(/\/$/, "") + "/"));
          return ok(fs.map((f) => f.split("/").pop()));
        }
        case "ps": {
          const procs = this.m.processus(c);
          return ok(["PID   USER     TIME  COMMAND"].concat(procs.map((p) => `${pad(p.pid, 5)} ${pad(p.user, 8)}  0:00 ${p.cmd}`)));
        }
        case "cat": {
          if (!a.length && entree) return ok(entree);
          for (const f of a) {
            const v = this.fichier(f);
            if (v === null) return ok(`cat: can't open '${f}': No such file or directory`, 1);
            out.push(...v.split("\n"));
          }
          return ok(out);
        }
        case "grep": {
          const motif = a.filter((x) => !x.startsWith("-"))[0] || "";
          const src = a.filter((x) => !x.startsWith("-"))[1];
          const lignes = src ? (this.fichier(src) || "").split("\n") : (entree || []);
          const re = new RegExp(motif.replace(/^\^/, "^"));
          const res = lignes.filter((l) => (a.includes("-v") ? !re.test(l) : re.test(l)));
          return ok(a.includes("-c") ? String(res.length) : res, res.length ? 0 : 1);
        }
        case "head": { const n = parseInt((a.find((x) => /^-\d+$/.test(x)) || "-10").slice(1), 10) || parseInt(a[a.indexOf("-n") + 1], 10) || 10; return ok((entree || []).slice(0, n)); }
        case "tail": {
          if (a.includes("/dev/zero")) {
            if (c.memoire) return { sortie: [], code: 137, oom: true };
            return ok("(simulateur : sans limite --memory, ce programme remplirait toute la mémoire de l'hôte ; arrêté par sécurité)", 130);
          }
          return ok((entree || []).slice(-10));
        }
        case "wc": return ok(String((entree || []).length));
        case "tr": return ok(entree || []);
        case "env": case "printenv": return ok(["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOSTNAME=" + c.id].concat(c.env));
        case "touch": case "mkdir": {
          if (c.readOnly) return ok(`${cmd}: ${a[0]}: Read-only file system`, 1);
          a.forEach((f) => { c.fichiers[f] = ""; }); return ok([]);
        }
        case "rm": a.filter((x) => !x.startsWith("-")).forEach((f) => delete c.fichiers[f]); return ok([]);
        case "for": {
          // for i in $(seq 1 N); do sleep 30 & done : test du plafond de processus
          const m = /seq 1 (\d+)/.exec(mots.join(" "));
          const n = m ? parseInt(m[1], 10) : 1;
          const deja = this.m.processus(c).length;
          if (c.pids && deja + n > c.pids) {
            const places = Math.max(0, c.pids - deja);
            for (let k = 0; k < places; k++) c.extra.push({ pid: 100 + k, pidHote: c.pidHote + 100 + k, user: c.user || "root", cmd: "sleep 30" });
            return ok("sh: can't fork: Resource temporarily unavailable", 2);
          }
          for (let k = 0; k < n; k++) c.extra.push({ pid: 100 + k, pidHote: c.pidHote + 100 + k, user: c.user || "root", cmd: "sleep 30" });
          return ok([]);
        }
        case "python3": case "python": return ok("Python 3.12.11");
        case "nginx": return ok(a.includes("-v") ? "nginx version: nginx/1.28.0" : "nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address in use)", a.includes("-v") ? 0 : 1);
        case "su": case "passwd": return ok(c.user && c.user !== "root" ? "su: must be suid to work properly" : "", 1);
        default: return ok(`sh: ${cmd}: not found`, 127);
      }
    }
  }

  /* --------------------------------------------- les commandes de l'hôte */
  class Hote {
    constructor() { this.m = new Moteur(); }

    executer(ligne) {
      const sortie = []; let code = 0;
      for (const morceau of separer(ligne, ";").flatMap((p) => separer(p, "&&"))) {
        const etapes = separer(morceau, "|");
        let flux = null;
        for (const e of etapes) {
          const r = this.commande(decouper(e), flux);
          flux = r.sortie; code = r.code;
        }
        sortie.push(...(flux || []));
        if (code !== 0 && ligne.includes("&&")) break;
      }
      return { sortie, code };
    }

    commande(mots, entree) {
      const [cmd, ...a] = mots;
      const ok = (l, code = 0) => ({ sortie: [].concat(l), code });
      if (cmd === "sudo") return this.commande(a, entree);
      if (cmd === "docker") return this.docker(a);
      if (cmd === undefined) return ok([]);
      // Filtres d'un tube.
      if (cmd === "grep") {
        const motif = a.filter((x) => !x.startsWith("-"))[0] || "";
        const re = new RegExp(motif, a.includes("-i") ? "i" : "");
        const res = (entree || []).filter((l) => (a.includes("-v") ? !re.test(l) : re.test(l)));
        return ok(a.includes("-c") ? String(res.length) : res, res.length ? 0 : 1);
      }
      if (cmd === "head") { const n = parseInt((a.find((x) => /^-\d+$/.test(x)) || "").slice(1), 10) || parseInt(a[a.indexOf("-n") + 1], 10) || 10; return ok((entree || []).slice(0, n)); }
      if (cmd === "tail") { const n = parseInt((a.find((x) => /^-\d+$/.test(x)) || "").slice(1), 10) || parseInt(a[a.indexOf("-n") + 1], 10) || 10; return ok((entree || []).slice(-n)); }
      if (cmd === "wc") return ok(String((entree || []).filter((l) => l !== "").length));
      if (cmd === "tr" || cmd === "cut" || cmd === "sort" || cmd === "uniq") return ok(cmd === "sort" ? (entree || []).slice().sort() : entree || []);
      switch (cmd) {
        case "echo": return ok(a.join(" "));
        case "hostname": return ok("lab");
        case "whoami": return ok("eleve");
        case "id": return ok("uid=1000(eleve) gid=1000(eleve) groups=1000(eleve),984(docker)");
        case "uname": return ok(a.includes("-r") ? "6.8.0-60-generic" : "Linux");
        case "pwd": return ok("/home/eleve");
        case "date": return ok(new Date().toString());
        case "ls": return ok("compose.yaml  site");
        case "nproc": return ok("4");
        case "ps": {
          const lignes = ["    PID TTY          TIME CMD", "      1 ?        00:00:03 systemd", "    812 ?        00:00:12 dockerd", "    840 ?        00:00:05 containerd"];
          this.m.conteneurs.filter((c) => c.etat === "running").forEach((c) => this.m.processus(c).forEach((p) => lignes.push(`${pad(String(p.pidHote).padStart(7), 7)} ?        00:00:00 ${p.cmd.split(" ")[0].replace(/:$/, "")}`)));
          return ok(lignes);
        }
        case "curl": case "wget": {
          const url = a.find((x) => /^https?:\/\//.test(x)) || "";
          const m = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?/.exec(url);
          const code = a.includes("-w") ? a[a.indexOf("-w") + 1] : null;
          const port = m ? (m[1] || "80") : null;
          const c = this.m.conteneurs.find((x) => x.etat === "running" && x.ports.some((p) => p.hote === port && ["127.0.0.1", "0.0.0.0"].includes(p.ip)));
          if (!c) return ok(cmd === "curl" ? (code ? "000" : `curl: (7) Failed to connect to 127.0.0.1 port ${port || "?"} after 0 ms: Couldn't connect to server`) : "wget: can't connect to remote host: Connection refused", 7);
          if (code) return ok(code.replace("%{http_code}", "200").replace("\\n", ""));
          return ok((c.repo === "nginx" ? NGINX_HTML : HTTPD_HTML).split("\n"));
        }
        case "clear": return { sortie: ["\u0000clear"], code: 0 };
        default: return ok(`${cmd}: command not found`, 127);
      }
    }

    docker(a) {
      const m = this.m; const sortie = []; let code = 0;
      const [sous, ...r] = a;
      const groupe = { container: true, image: true, volume: true, network: true };
      if (groupe[sous] && r[0]) return this.docker(this.alias(sous, r));
      switch (sous) {
        case undefined: case "--help": case "help":
          sortie.push("Usage:  docker [OPTIONS] COMMAND", "", "Commandes simulées : run, ps, exec, logs, top, inspect, stats, stop, start, restart, rm, kill,",
            "  images, pull, rmi, volume ls|create|rm, network ls|create|rm, version, info", "Hors Docker : curl, ps, uname, hostname, id, clear, help, reset");
          break;
        case "--version": case "-v": sortie.push("Docker version 29.8.0, build 88096ef (simulateur)"); break;
        case "version": sortie.push("Client: Docker Engine - Community", " Version:           29.8.0", "", "Server: Docker Engine - Community (simulateur)", " Engine:", "  Version:          29.8.0", " containerd:", "  Version:          v2.3.5", " runc:", "  Version:          1.5.1"); break;
        case "info": sortie.push(`Server:`, ` Containers: ${m.conteneurs.length}`, `  Running: ${m.conteneurs.filter((c) => c.etat === "running").length}`, `  Stopped: ${m.conteneurs.filter((c) => c.etat !== "running").length}`, ` Images: ${Object.keys(m.images).length}`, " Cgroup Driver: systemd", " Cgroup Version: 2", " Security Options:", "  seccomp", "   Profile: builtin", " Kernel Version: 6.8.0-60-generic", " Operating System: Ubuntu 24.04 LTS (simulateur)", " CPUs: 4", " Total Memory: 7.602GiB"); break;
        case "run": code = m.run(r, sortie); break;
        case "create": { code = m.run(["-d"].concat(r), sortie); const c = m.conteneurs[m.conteneurs.length - 1]; if (c && code === 0) { c.etat = "created"; c.finit = now(); } break; }
        case "ps": code = m.ps(r, sortie); break;
        case "top": code = m.top(r, sortie); break;
        case "inspect": code = m.inspect(r, sortie); break;
        case "stats": code = m.stats(r, sortie); break;
        case "logs": {
          const c = m.trouver(r.filter((x) => !x.startsWith("-")).pop() || "");
          if (!c) { sortie.push(`Error response from daemon: No such container: ${r[r.length - 1] || ""}`); code = 1; }
          else sortie.push(...c.logs);
          break;
        }
        case "exec": {
          const opts = []; let i = 0;
          for (; i < r.length && r[i].startsWith("-"); i++) { opts.push(r[i]); if (["-u", "--user", "-e", "-w"].includes(r[i])) i++; }
          const c = m.trouver(r[i] || "");
          if (!c) { sortie.push(`Error response from daemon: No such container: ${r[i] || ""}`); code = 1; break; }
          if (c.etat !== "running") { sortie.push(`Error response from daemon: container ${c.idLong} is not running`); code = 1; break; }
          const prog = r.slice(i + 1);
          if (!prog.length) { sortie.push('"docker exec" requires at least 2 arguments.'); code = 1; break; }
          if (prog.length === 1 && ["sh", "bash", "/bin/sh", "/bin/bash"].includes(prog[0])) { sortie.push("(simulateur : pas de shell interactif ; tape plutôt docker exec " + c.nom + " <commande>)"); break; }
          const res = new Shell(m, c).executer(prog.map((x) => (/\s/.test(x) ? `'${x}'` : x)).join(" "));
          sortie.push(...res.sortie); code = res.code;
          if (res.oom) { m.arreter(c, 137, true); }
          break;
        }
        case "stop": case "kill":
          for (const n of r.filter((x) => !x.startsWith("-"))) {
            const c = m.trouver(n);
            if (!c) { sortie.push(`Error response from daemon: No such container: ${n}`); code = 1; continue; }
            if (c.etat === "running") m.arreter(c, sous === "kill" ? 137 : (c.repo === "nginx" || c.repo === "httpd" ? 0 : 137));
            if (c.rm) m.conteneurs = m.conteneurs.filter((x) => x !== c);
            sortie.push(n);
          }
          break;
        case "start": case "restart":
          for (const n of r.filter((x) => !x.startsWith("-"))) {
            const c = m.trouver(n);
            if (!c) { sortie.push(`Error response from daemon: No such container: ${n}`); code = 1; continue; }
            c.etat = "running"; c.demarre = now(); c.code = 0; c.oom = false; c.extra = []; sortie.push(n);
          }
          break;
        case "rm": {
          const force = r.some((x) => /^-[a-z]*f/.test(x) || x === "--force");
          const vol = r.some((x) => /^-[a-z]*v/.test(x) || x === "--volumes");
          for (const n of r.filter((x) => !x.startsWith("-"))) {
            const c = m.trouver(n);
            if (!c) { sortie.push(`Error response from daemon: No such container: ${n}`); code = 1; continue; }
            if (c.etat === "running" && !force) {
              sortie.push(`Error response from daemon: cannot remove container "/${c.nom}": container is running: stop the container before removing or force remove`); code = 1; continue;
            }
            if (vol) c.vols.forEach((v) => { const nv = v.split(":")[0]; if (/^[0-9a-f]{64}$/.test(nv)) delete m.volumes[nv]; });
            m.conteneurs = m.conteneurs.filter((x) => x !== c); sortie.push(n);
          }
          break;
        }
        case "images": {
          const lignes = Object.entries(m.images).map(([ref, im]) => { const [repo, tag] = ref.split(":"); return [repo, tag, im.id, duree(now() - im.cree) + " ago", CATALOGUE[repo].taille]; });
          sortie.push(tableau([["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"]].concat(lignes)));
          break;
        }
        case "pull": { const res = m.tirer(r[0] || "", sortie); if (res && !sortie.length) sortie.push(`${res.tag}: Pulling from library/${res.repo}`, `Digest: sha256:${hex(64)}`, `Status: Image is up to date for ${res.ref}`); code = res ? 0 : 1; break; }
        case "rmi": {
          for (const n of r.filter((x) => !x.startsWith("-"))) {
            const ref = refImage(n).ref;
            if (!m.images[ref]) { sortie.push(`Error response from daemon: No such image: ${ref}`); code = 1; continue; }
            const util = m.conteneurs.find((c) => c.ref === ref);
            if (util && !r.includes("-f")) { sortie.push(`Error response from daemon: conflict: unable to delete ${ref} (must be forced) - container ${util.id} is using its referenced image ${m.images[ref].id}`); code = 1; continue; }
            delete m.images[ref]; sortie.push(`Untagged: ${ref}`, `Deleted: sha256:${hex(64)}`);
          }
          break;
        }
        case "volume-ls": sortie.push(tableau([["DRIVER", "VOLUME NAME"]].concat(Object.keys(m.volumes).map((v) => ["local", v])))); break;
        case "volume-create": { const n = r[0] || hex(64); m.volumes[n] = m.volumes[n] || { cree: now(), fichiers: {} }; sortie.push(n); break; }
        case "volume-rm":
          for (const n of r.filter((x) => !x.startsWith("-"))) {
            if (!m.volumes[n]) { sortie.push(`Error response from daemon: get ${n}: no such volume`); code = 1; continue; }
            const util = m.conteneurs.find((c) => c.vols.some((v) => v.split(":")[0] === n));
            if (util) { sortie.push(`Error response from daemon: remove ${n}: volume is in use - [${util.idLong}]`); code = 1; continue; }
            delete m.volumes[n]; sortie.push(n);
          }
          break;
        case "network-ls": sortie.push(tableau([["NETWORK ID", "NAME", "DRIVER", "SCOPE"]].concat(Object.entries(m.reseaux).map(([n, x]) => [x.id, n, x.driver, "local"])))); break;
        case "network-create": { const n = r.filter((x) => !x.startsWith("-"))[0]; if (m.reseaux[n]) { sortie.push(`Error response from daemon: network with name ${n} already exists`); code = 1; } else { m.reseaux[n] = { id: hex(12), driver: "bridge" }; sortie.push(hex(64)); } break; }
        case "network-rm": for (const n of r) { if (!m.reseaux[n]) { sortie.push(`Error response from daemon: network ${n} not found`); code = 1; } else { delete m.reseaux[n]; sortie.push(n); } } break;
        default:
          sortie.push(`(simulateur : « docker ${sous} » n'est pas encore simulé ici. Tape « help » pour la liste, ou fais-le sur un vrai Docker.)`);
          code = 1;
      }
      return { sortie, code };
    }

    alias(groupe, r) {
      const [action, ...reste] = r;
      if (groupe === "container") return [{ ls: "ps", list: "ps" }[action] || action].concat(reste);
      if (groupe === "image") return [{ ls: "images", list: "images", rm: "rmi" }[action] || action].concat(reste);
      return [groupe + "-" + ({ list: "ls" }[action] || action)].concat(reste);
    }
  }

  /* ------------------------------------------------------- le composant */
  const scriptCourant = document.currentScript && document.currentScript.src;

  function creer(el) {
    if (el.dataset.pret) return;
    el.dataset.pret = "1";
    const hote = new Hote();
    const historique = []; let posHist = 0;
    let lab = null; let etape = 0; let mode = "libre";

    el.innerHTML = `
      <div class="ts-barre"><span class="ts-points"><i></i><i></i><i></i></span>
        <span class="ts-titre">eleve@lab: ~ · simulateur Docker</span>
        <span class="ts-modes" role="tablist">
          <button type="button" class="ts-mode" data-mode="guide" role="tab">Guidé</button>
          <button type="button" class="ts-mode" data-mode="libre" role="tab">Libre</button>
        </span>
        <button type="button" class="ts-reset" title="Remettre la machine à zéro">↺</button>
      </div>
      <div class="ts-etape" hidden></div>
      <div class="ts-ecran" aria-live="polite"></div>
      <label class="ts-ligne"><span class="ts-invite">eleve@lab:~$</span>
        <input class="ts-saisie" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Commande à taper dans le terminal simulé"></label>`;
    const ecran = el.querySelector(".ts-ecran");
    const saisie = el.querySelector(".ts-saisie");
    const panneau = el.querySelector(".ts-etape");

    const ecrire = (texte, classe) => {
      const p = document.createElement("div");
      p.className = "ts-sortie" + (classe ? " " + classe : "");
      p.textContent = texte;
      ecran.appendChild(p);
      ecran.scrollTop = ecran.scrollHeight;
    };
    const ecrireCommande = (cmd) => {
      const p = document.createElement("div");
      p.className = "ts-cmd";
      p.innerHTML = '<span class="ts-invite">eleve@lab:~$</span> ';
      p.appendChild(document.createTextNode(cmd));
      ecran.appendChild(p);
    };

    function accueil() {
      ecran.innerHTML = "";
      if (el.dataset.seul) { ecrire("Ta machine Docker simulée. Suis le tutoriel à droite : clique sur « Insérer dans le terminal », puis appuie sur Entrée. Tu peux aussi taper ce que tu veux.", "ts-info"); return; }
      ecrire(mode === "guide"
        ? "Mode guidé : suis les étapes du lab. Tape la commande, ou clique sur « Insérer la commande »."
        : "Mode libre : une machine Docker simulée rien que pour toi. Essaie, casse, recommence. Tape « help » pour la liste des commandes.", "ts-info");
    }

    function afficherEtape() {
      if (mode !== "guide" || !lab) { panneau.hidden = true; return; }
      panneau.hidden = false;
      if (etape >= lab.etapes.length) {
        panneau.innerHTML = `<div class="ts-fin">✓ Lab terminé ! Passe en mode Libre pour expérimenter à ta guise.</div>`;
        return;
      }
      const e = lab.etapes[etape];
      panneau.innerHTML = `<div class="ts-num">Étape ${etape + 1} / ${lab.etapes.length}</div>
        <div class="ts-consigne"><strong></strong><span></span></div>
        <div class="ts-actions"><code></code><button type="button" class="ts-inserer">Insérer la commande</button></div>`;
      panneau.querySelector("strong").textContent = e.titre + " · ";
      panneau.querySelector(".ts-consigne span").textContent = e.consigne;
      panneau.querySelector("code").textContent = e.commande;
      panneau.querySelector(".ts-inserer").onclick = () => { saisie.value = e.commande; saisie.focus(); };
    }

    function verifier(cmd) {
      if (mode !== "guide" || !lab || etape >= lab.etapes.length) return;
      const e = lab.etapes[etape];
      const norm = (s) => s.replace(/\s+/g, " ").trim();
      const re = new RegExp(e.attendu || "^" + norm(e.commande).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
      if (re.test(norm(cmd))) {
        if (e.bravo) ecrire("✓ " + e.bravo, "ts-ok");
        etape++; afficherEtape();
      } else if (e.indice) {
        ecrire("↪ Indice : " + e.indice, "ts-indice");
      }
    }

    // Temps de réponse réaliste : une commande ne répond jamais instantanément.
    let occupe = false; let interrompu = false;
    const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const entre = (a, b) => a + Math.random() * (b - a);
    function latence(cmd) {
      const mots = decouper(cmd.replace(/^\s*sudo\s+/, ""));
      const [outil, sous] = mots;
      let avant = entre(10, 60);
      if (outil === "docker") {
        avant = {
          run: entre(350, 900), create: entre(250, 600), pull: entre(300, 700), stop: entre(400, 1200), restart: entre(500, 1300),
          start: entre(250, 700), kill: entre(150, 400), rm: entre(150, 450), rmi: entre(200, 500), exec: entre(120, 350),
          stats: entre(900, 1600), inspect: entre(60, 180), ps: entre(60, 200), images: entre(60, 200), logs: entre(50, 150),
          top: entre(100, 250), version: entre(100, 300), info: entre(150, 400),
        }[sous] || entre(80, 220);
      } else if (outil === "curl" || outil === "wget") avant = entre(40, 180);
      const ligne = (l, i) => {
        if (/Pull complete/.test(l)) return entre(250, 700);
        if (/Pulling from|Downloaded newer image|Image is up to date/.test(l)) return entre(150, 400);
        if (/^Digest:|^Unable to find/.test(l)) return entre(80, 180);
        return i === 0 ? 0 : entre(3, 14);
      };
      return { avant, ligne };
    }

    async function lancer(cmd) {
      ecrireCommande(cmd);
      if (!cmd.trim()) return;
      historique.push(cmd); posHist = historique.length;
      const t = cmd.trim();
      if (t === "clear") { ecran.innerHTML = ""; return; }
      if (t === "reset") { hote.m.reinitialiser(); accueil(); ecrire("Machine remise à zéro.", "ts-info"); return; }
      if (t === "help") { hote.executer("docker help").sortie.forEach((l) => ecrire(l)); return; }
      const res = hote.executer(cmd);
      const lat = latence(cmd);
      occupe = true; interrompu = false; saisie.readOnly = true; el.classList.add("ts-occupe");
      await attendre(lat.avant);
      for (let i = 0; i < res.sortie.length && !interrompu; i++) {
        const d = lat.ligne(res.sortie[i], i);
        if (d) await attendre(d);
        if (interrompu) break;
        const l = res.sortie[i];
        ecrire(l, res.code && /^(docker:|Error|curl:|sh:|cat:|\(simulateur)/.test(l) ? "ts-erreur" : "");
      }
      if (interrompu) ecrire("^C");
      occupe = false; saisie.readOnly = false; el.classList.remove("ts-occupe");
      ecran.scrollTop = ecran.scrollHeight;
      if (!interrompu) {
        verifier(cmd);
        el.dispatchEvent(new CustomEvent("ts-commande", { detail: { cmd, code: res.code, sortie: res.sortie } }));
      }
    }

    saisie.addEventListener("keydown", (ev) => {
      if (occupe) { if (ev.key === "c" && ev.ctrlKey) interrompu = true; ev.preventDefault(); return; }
      if (ev.key === "Enter") { const v = saisie.value; saisie.value = ""; lancer(v); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { if (posHist > 0) { posHist--; saisie.value = historique[posHist]; } ev.preventDefault(); }
      else if (ev.key === "ArrowDown") { if (posHist < historique.length - 1) { posHist++; saisie.value = historique[posHist]; } else { posHist = historique.length; saisie.value = ""; } ev.preventDefault(); }
      else if (ev.key === "l" && ev.ctrlKey) { ecran.innerHTML = ""; ev.preventDefault(); }
    });
    ecran.addEventListener("click", () => saisie.focus());
    el.addEventListener("ts-inserer", (ev) => { saisie.value = ev.detail; saisie.focus(); });

    const choisirMode = (m) => {
      mode = m;
      el.querySelectorAll(".ts-mode").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
      if (m === "guide") { etape = 0; hote.m.reinitialiser(); }
      accueil(); afficherEtape();
    };
    el.querySelectorAll(".ts-mode").forEach((b) => (b.onclick = () => choisirMode(b.dataset.mode)));
    el.querySelector(".ts-reset").onclick = () => { hote.m.reinitialiser(); etape = 0; accueil(); afficherEtape(); el.dispatchEvent(new CustomEvent("ts-reset")); };

    const nomLab = el.dataset.lab;
    if (el.dataset.seul) {
      // Terminal d'une page de lab : le tutoriel est à côté, pas dans le terminal.
      el.querySelector(".ts-modes").hidden = true;
      choisirMode("libre");
    } else if (nomLab && scriptCourant) {
      fetch(new URL(`../assets/labs/${nomLab}.json`, scriptCourant)).then((r) => r.json()).then((j) => { lab = j; choisirMode("guide"); })
        .catch(() => choisirMode("libre"));
    } else {
      el.querySelector('.ts-mode[data-mode="guide"]').hidden = true;
      choisirMode("libre");
    }
  }


  /* --------------------------------------------- page de lab : terminal + tutoriel */
  const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms)); // const attendreG
  const echapper = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Mise en forme légère dans les textes du tutoriel : **gras** et `code`.
  const enrichir = (s) => echapper(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const mouvementReduit = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Conti, le robot du lab : SVG animé par CSS (classes parle, content, pensif). */
  const ROBOT = `<svg class="robot" viewBox="0 0 120 140" aria-hidden="true">
      <g class="rb-corps">
        <line x1="60" y1="8" x2="60" y2="24" stroke="#a0a4a0" stroke-width="3"/>
        <circle class="rb-lampe" cx="60" cy="8" r="6" fill="#eeff57"/>
        <rect class="rb-tete" x="22" y="24" width="76" height="56" rx="18" fill="#1f9e91"/>
        <rect x="31" y="33" width="58" height="38" rx="11" fill="#0a0006"/>
        <g class="rb-yeux"><ellipse class="rb-oeil" cx="47" cy="49" rx="6" ry="7" fill="#5affb6"/><ellipse class="rb-oeil" cx="73" cy="49" rx="6" ry="7" fill="#5affb6"/></g>
        <g class="rb-yeux-joie"><path d="M41 51 q6 -9 12 0" stroke="#5affb6" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M67 51 q6 -9 12 0" stroke="#5affb6" stroke-width="3.5" fill="none" stroke-linecap="round"/></g>
        <rect class="rb-bouche" x="52" y="60" width="16" height="4" rx="2" fill="#5affb6"/>
        <circle cx="22" cy="52" r="5" fill="#187b73"/><circle cx="98" cy="52" r="5" fill="#187b73"/>
        <rect x="34" y="84" width="52" height="40" rx="12" fill="#1d1d1d" stroke="#1f9e91" stroke-width="2"/>
        <rect x="42" y="94" width="36" height="5" rx="2.5" fill="url(#rb-grad)"/>
        <circle cx="50" cy="110" r="3.5" fill="#ff84ef"/><circle cx="60" cy="110" r="3.5" fill="#00eaff"/><circle cx="70" cy="110" r="3.5" fill="#eeff57"/>
        <g class="rb-bras-g"><rect x="18" y="88" width="16" height="9" rx="4.5" fill="#1f9e91"/></g>
        <g class="rb-bras-d"><rect x="86" y="88" width="16" height="9" rx="4.5" fill="#1f9e91"/></g>
      </g>
      <defs><linearGradient id="rb-grad" x1="0" x2="1"><stop offset="0" stop-color="#ff1a1a"/><stop offset=".3" stop-color="#eeff57"/><stop offset=".55" stop-color="#5affb6"/><stop offset=".8" stop-color="#00eaff"/><stop offset="1" stop-color="#859cff"/></linearGradient></defs>
    </svg>`;

  function scene(nom, attente) {
    return `<div class="robot-scene${attente ? " en-attente" : ""}">
        <div class="robot-boite">${ROBOT}</div>
        <div class="robot-bulle" role="status" aria-live="polite">
          <div class="robot-nom">${echapper(nom)}</div>
          <div class="robot-texte"></div>
          <button type="button" class="robot-passer" hidden>Passer ▸</button>
        </div>
      </div>`;
  }

  // Fait parler le robot : texte tapé lettre par lettre, bouche animée. Rend une promesse.
  function dire(sceneEl, phrases, opts = {}) {
    const texte = sceneEl.querySelector(".robot-texte");
    const robot = sceneEl.querySelector(".robot");
    const passer = sceneEl.querySelector(".robot-passer");
    if (!opts.ajout) texte.innerHTML = "";
    let vite = mouvementReduit() || !!opts.instant;
    passer.hidden = vite;
    passer.onclick = () => { vite = true; };
    sceneEl.classList.add("parle");
    return (async () => {
      for (const phrase of phrases) {
        const p = document.createElement("p");
        if (opts.classe) p.className = opts.classe;
        texte.appendChild(p);
        const html = enrichir(phrase);
        if (vite) { p.innerHTML = html; continue; }
        // On tape le texte brut, puis on remet la mise en forme à la fin de la phrase.
        const brut = Array.from(phrase.replace(/\*\*|`/g, "")); // par caractère, émojis compris
        for (let k = 1; k <= brut.length; k++) {
          if (vite) break;
          p.textContent = brut.slice(0, k).join("");
          const ch = brut[k - 1];
          await attendre(/[.!?]/.test(ch) ? 220 : /[,:;]/.test(ch) ? 110 : 20 + Math.random() * 18);
        }
        p.innerHTML = html;
        if (!vite) await attendre(380);
      }
      sceneEl.classList.remove("parle");
      passer.hidden = true;
      void robot;
    })();
  }

  function reagir(sceneEl, humeur) {
    sceneEl.classList.remove("content", "pensif");
    void sceneEl.offsetWidth; // relance l'animation
    sceneEl.classList.add(humeur);
  }

  function popXP(sceneEl, points) {
    const pop = document.createElement("div");
    pop.className = "xp-pop";
    pop.textContent = `+${points} XP`;
    sceneEl.appendChild(pop);
    setTimeout(() => pop.remove(), 1600);
  }

  function creerLab(racine) {
    if (racine.dataset.pret) return;
    racine.dataset.pret = "1";
    const nom = racine.dataset.lab;
    racine.innerHTML = `<div class="lab-split">
        <section class="lab-gauche"><div class="terminal-sim" data-seul="1"></div></section>
        <aside class="lab-droite"><div class="lab-chargement">Chargement du lab…</div></aside>
      </div>`;
    const term = racine.querySelector(".terminal-sim");
    const guide = racine.querySelector(".lab-droite");
    creer(term);
    fetch(new URL(`../assets/labs/${nom}.json`, scriptCourant)).then((r) => r.json()).then((lab) => {
      let courant = 0; let xp = 0;
      const etapes = lab.etapes;
      const nomRobot = lab.robotNom || "Conti";
      const indiceUtilise = new Set();
      guide.innerHTML = `
        <header class="lab-entete">
          <div class="lab-sur">Lab interactif${lab.duree ? " · " + echapper(lab.duree) : ""}</div>
          <h2 class="lab-titre">${echapper(lab.titre)}</h2>
          <div class="lab-progression"><div class="lab-barre"><span></span></div><span class="lab-compte"></span><span class="lab-xp">0 XP</span></div>
          <div class="lab-accueil">${scene(nomRobot)}</div>
        </header>
        <ol class="lab-etapes">${etapes.map((e, i) => `
          <li class="lab-etape" data-i="${i}">
            <button type="button" class="lab-tete"><span class="lab-pastille">${i + 1}</span><span class="lab-nom">${echapper(e.titre)}</span></button>
            <div class="lab-corps">
              ${scene(nomRobot, true)}
              <div class="lab-details">
                ${e.pourquoi ? `<p class="lab-pourquoi">${enrichir(e.pourquoi)}</p>` : ""}
                <p class="lab-consigne"><strong>À faire :</strong> ${enrichir(e.consigne)}</p>
                <div class="lab-commande"><code>${echapper(e.commande)}</code>
                  <span class="lab-boutons"><button type="button" class="lab-inserer">Insérer dans le terminal</button><button type="button" class="lab-copier">Copier</button></span></div>
                ${e.options && e.options.length ? `<dl class="lab-options">${e.options.map(([o, x]) => `<dt><code>${echapper(o)}</code></dt><dd>${enrichir(x)}</dd>`).join("")}</dl>` : ""}
                ${e.sortie ? `<div class="lab-attendu"><div class="lab-libelle">Tu dois voir à peu près :</div><pre>${echapper(e.sortie)}</pre></div>` : ""}
                ${e.remarque ? `<p class="lab-remarque"><strong>À remarquer :</strong> ${enrichir(e.remarque)}</p>` : ""}
                ${e.indice ? `<details class="lab-indice"><summary>Besoin d'un indice ?</summary><p>${enrichir(e.indice)}</p></details>` : ""}
              </div>
            </div>
          </li>`).join("")}
        </ol>
        <div class="lab-final" hidden>
          <div class="lab-final-scene">${scene(nomRobot)}</div>
          ${lab.badge ? `<div class="lab-badge"><span class="lab-badge-icone">🏅</span><span><strong>Badge débloqué</strong><br>${echapper(lab.badge)}</span></div>` : ""}
          ${lab.conclusion ? `<p>${enrichir(lab.conclusion)}</p>` : ""}
          ${lab.retour ? `<p><a class="md-button md-button--primary" href="${echapper(lab.retour.lien)}">${echapper(lab.retour.texte)}</a></p>` : ""}
        </div>`;
      const items = [...guide.querySelectorAll(".lab-etape")];
      const joue = new Set();

      const maj = () => {
        items.forEach((li, i) => {
          li.classList.toggle("fait", i < courant);
          li.classList.toggle("actif", i === courant);
          li.classList.toggle("ouvert", i === courant || li.classList.contains("deplie"));
        });
        const n = Math.min(courant, etapes.length);
        guide.querySelector(".lab-barre span").style.width = Math.round((n / etapes.length) * 100) + "%";
        guide.querySelector(".lab-compte").textContent = `${n} / ${etapes.length} étapes`;
        guide.querySelector(".lab-xp").textContent = `${xp} XP`;
        guide.querySelector(".lab-final").hidden = courant < etapes.length;
      };

      // Présentation d'une étape : le robot parle d'abord, puis les explications apparaissent.
      const presenter = async (i, instant) => {
        const li = items[i]; const e = etapes[i];
        const sc = li.querySelector(".robot-scene");
        const details = li.querySelector(".lab-details");
        sc.classList.remove("en-attente");
        if (joue.has(i) || instant) {
          details.classList.add("visible");
          if (!joue.has(i)) { joue.add(i); await dire(sc, e.robot || [e.consigne], { instant: true }); }
          return;
        }
        joue.add(i);
        details.classList.remove("visible");
        sc.classList.add("entree");
        await attendre(mouvementReduit() ? 0 : 450);
        await dire(sc, e.robot || [e.consigne]);
        details.classList.add("visible");
      };

      items.forEach((li, i) => {
        const e = etapes[i];
        li.querySelector(".lab-tete").onclick = () => { li.classList.toggle("deplie"); maj(); if (li.classList.contains("ouvert")) presenter(i, true); };
        li.querySelector(".lab-inserer").onclick = () => term.dispatchEvent(new CustomEvent("ts-inserer", { detail: e.commande }));
        li.querySelector(".lab-copier").onclick = (ev) => {
          const bouton = ev.currentTarget;
          (navigator.clipboard ? navigator.clipboard.writeText(e.commande) : Promise.reject(new Error("presse-papiers indisponible")))
            .then(() => { bouton.textContent = "Copié ✓"; }, () => { bouton.textContent = "Sélectionne et copie"; });
          setTimeout(() => { bouton.textContent = "Copier"; }, 1600);
        };
        const ind = li.querySelector(".lab-indice");
        if (ind) ind.addEventListener("toggle", () => { if (ind.open) indiceUtilise.add(i); });
      });

      const norm = (s) => s.replace(/\s+/g, " ").trim();
      // Les deux premiers mots (« docker run », « curl http… ») : sert à distinguer une tentative ratée d'une exploration.
      const debut = (s) => norm(s).split(" ").slice(0, 2).join(" ");
      term.addEventListener("ts-commande", async (ev) => {
        if (courant >= etapes.length) return;
        const i = courant; const e = etapes[i]; const li = items[i];
        const sc = li.querySelector(".robot-scene");
        const re = new RegExp(e.attendu || "^" + norm(e.commande).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
        if (re.test(norm(ev.detail.cmd))) {
          const points = indiceUtilise.has(i) ? 10 : 15;
          xp += points; courant++;
          sc.scrollIntoView({ behavior: "smooth", block: "nearest" });
          reagir(sc, "content"); popXP(sc, points);
          li.querySelector(".lab-details").classList.add("visible");
          await dire(sc, ["✓ " + (e.bravo || "Bien joué !")], { ajout: true, classe: "robot-bravo", instant: false });
          maj();
          await attendre(mouvementReduit() ? 0 : 700);
          if (courant < etapes.length) {
            items[courant].scrollIntoView({ behavior: "smooth", block: "start" });
            presenter(courant);
          } else {
            const fin = guide.querySelector(".lab-final");
            fin.scrollIntoView({ behavior: "smooth", block: "start" });
            const scf = fin.querySelector(".robot-scene");
            scf.classList.add("entree"); reagir(scf, "content");
            dire(scf, lab.robotFin || ["Bravo, tu as terminé le lab !", `Total : **${xp} XP**.`]);
          }
        } else if (debut(ev.detail.cmd) === debut(e.commande)) {
          reagir(sc, "pensif");
          sc.querySelectorAll(".robot-indice").forEach((n) => n.remove()); // un seul indice affiché à la fois
          sc.scrollIntoView({ behavior: "smooth", block: "nearest" });
          if (e.indice) {
            indiceUtilise.add(i);
            const d = li.querySelector(".lab-indice"); if (d) d.open = true;
          }
          dire(sc, ["Hmm, pas tout à fait… " + (e.indice || "Compare ta commande avec celle de la consigne, ou clique sur « Insérer dans le terminal ».")], { ajout: true, classe: "robot-indice" });
        }
      });
      term.addEventListener("ts-reset", () => {
        courant = 0; xp = 0; indiceUtilise.clear(); joue.clear();
        items.forEach((li) => { li.classList.remove("deplie"); li.querySelector(".lab-details").classList.remove("visible"); });
        maj(); presenter(0);
      });

      maj();
      (async () => {
        const acc = guide.querySelector(".lab-accueil .robot-scene");
        acc.classList.add("entree");
        await attendre(mouvementReduit() ? 0 : 300);
        await dire(acc, lab.robotIntro || (lab.intro ? [lab.intro] : ["C'est parti !"]));
        presenter(0);
      })();
    }).catch(() => { guide.innerHTML = '<p class="lab-chargement">Impossible de charger le tutoriel de ce lab.</p>'; });
  }

  function tout() { document.querySelectorAll(".lab-page").forEach(creerLab); document.querySelectorAll(".terminal-sim").forEach(creer); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tout); else tout();
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(tout);
  new MutationObserver(tout).observe(document.documentElement, { childList: true, subtree: true });
  window.DockerSim = { Hote, Moteur }; // pour les tests
})();
