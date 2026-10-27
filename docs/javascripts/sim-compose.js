/* Simulateur, Docker Compose 5 : projets, interpolation, depends_on et healthchecks, recréation,
 * --scale, secrets, config normalisée, ps, logs, exec, down. Lit le YAML avec js-yaml. */
(function (G) {
  "use strict";
  const SIM = G.SIM; const O = SIM.outils; const R = SIM.R; const H = SIM.horloge; const chemin = SIM.chemin; const D = SIM.docker;
  const DOCKER = D.commandes;
  const yaml = () => G.jsyaml;
  const VERSION = "v5.5.0";

  /* --------------------------------------------------------- chargement */
  const FICHIERS = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  function interpoler(texte, env) {
    let erreur = null;
    const out = texte.replace(/\$\$|\$\{([A-Za-z_]\w*)(?:(:?)([-?])([^}]*))?\}|\$([A-Za-z_]\w*)/g, (tout, a, deux, op, def, b) => {
      if (tout === "$$") return "\u0000";
      const nom = a || b; const v = env[nom];
      const vide = v === undefined || (deux && v === "");
      if (op === "-" && vide) return def;
      if (op === "?" && vide) { erreur = erreur || `required variable ${nom} is missing a value: ${def}`; return ""; }
      return v === undefined ? "" : v;
    });
    return { texte: out, erreur };
  }
  function lireEnv(fs, dossier) {
    const f = fs.lire(dossier + "/.env");
    const e = {};
    if (!f.err) f.contenu.split("\n").forEach((l) => { const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(l); if (m && !l.trim().startsWith("#")) e[m[1]] = m[2].replace(/^["']|["']$/g, ""); });
    return e;
  }
  const decouperCommande = (s) => { const r = SIM.lexer(String(s)); return r.toks.filter((t) => t.type === "mot").map((t) => t.parts.map((p) => p.t).join("")); };

  // Charge le projet : {nom, dossier, fichiers, services: {nom: svc normalisé}, reseaux, volumes, secrets} ou {erreur}.
  function charger(m, x, o) {
    const fs = m.hote.fs;
    let dossier = o.dossier ? chemin.norm(o.dossier, x.sh.cwd) : x.sh.cwd;
    let fichiers = o.fichiers.map((f) => chemin.norm(f, x.sh.cwd));
    if (!fichiers.length) {
      let d = dossier;
      for (;;) {
        const f = FICHIERS.map((n) => (d === "/" ? "/" : d + "/") + n).find((p) => fs.stat(p));
        if (f) { fichiers = [f]; dossier = d; break; }
        if (d === "/") return { erreur: "no configuration file provided: not found" };
        d = chemin.parent(d);
      }
    } else if (!o.dossier) dossier = chemin.parent(fichiers[0]);
    const env = Object.assign({}, lireEnv(fs, dossier), x.env);
    let brut = {};
    for (const f of fichiers) {
      const lu = fs.lire(f);
      if (lu.err) return { erreur: `open ${f}: no such file or directory` };
      const it = interpoler(lu.contenu, env);
      if (it.erreur) return { erreur: it.erreur };
      if (/^\t/m.test(it.texte)) { const k = it.texte.split("\n").findIndex((l) => l.startsWith("\t")); return { erreur: `go-yaml load error in scanner (while scanning for the next token) at L${k + 1}.C1: found character that cannot start any token` }; }
      let doc;
      try { doc = yaml().load(it.texte.replace(/\u0000/g, "$$")); } catch (e) { return { erreur: `yaml: line ${(e.mark && e.mark.line + 1) || 1}: ${(e.reason || e.message).replace(/^bad indentation of a mapping entry$/, "mapping values are not allowed in this context")}` }; }
      if (doc === undefined || doc === null) doc = {};
      if (typeof doc !== "object" || Array.isArray(doc)) return { erreur: "Top-level object must be a mapping" };
      brut = fusionner(brut, doc);
    }
    if (!brut.services || typeof brut.services !== "object") return { erreur: brut.services === undefined ? "no service selected" : "services must be a mapping" };
    const nom = (o.projet || env.COMPOSE_PROJECT_NAME || brut.name || chemin.base(dossier)).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const p = { nom, dossier, fichiers, services: {}, reseaux: {}, volumes: {}, secrets: {}, brut, env };
    for (const [n, s] of Object.entries(brut.services)) {
      if (s === null || typeof s !== "object" || Array.isArray(s)) return { erreur: `services.${n} must be a mapping` };
      for (const [k, v] of Object.entries(s)) if (k === "image" && typeof v !== "string") return { erreur: `services.${n}.image must be a string` };
      if (!s.image && !s.build) return { erreur: `service "${n}" has neither an image nor a build context specified: invalid compose project` };
      const r = normaliserService(n, s, p, fs);
      if (r.erreur) return r;
      p.services[n] = r;
    }
    Object.entries(brut.volumes || {}).forEach(([n, v]) => { p.volumes[n] = { nom: (v && v.name) || `${nom}_${n}`, externe: !!(v && v.external) }; });
    const reseauxUtilises = new Set(); Object.values(p.services).forEach((s) => Object.keys(s.reseaux).forEach((r) => reseauxUtilises.add(r)));
    Object.entries(brut.networks || {}).forEach(([n, v]) => { p.reseaux[n] = { nom: (v && v.name) || `${nom}_${n}`, externe: !!(v && v.external), interne: !!(v && v.internal) }; });
    if (reseauxUtilises.has("default") && !p.reseaux.default) p.reseaux.default = { nom: `${nom}_default` };
    for (const [n, v] of Object.entries(brut.secrets || {})) {
      if (v && v.file) p.secrets[n] = { fichier: chemin.norm(v.file, dossier) };
      else if (v && v.environment) p.secrets[n] = { env: v.environment };
    }
    for (const s of Object.values(p.services)) {
      for (const d of Object.keys(s.depends_on)) if (!p.services[d]) return { erreur: `service "${s.nom}" depends on undefined service "${d}": invalid compose project` };
      for (const sc of s.secrets) if (!p.secrets[sc.source]) return { erreur: `service "${s.nom}" refers to undefined secret ${sc.source}: invalid compose project` };
    }
    return p;
  }
  function fusionner(a, b) {
    if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
    const out = Object.assign({}, a);
    for (const [k, v] of Object.entries(b)) out[k] = a && typeof a[k] === "object" && !Array.isArray(a[k]) && a[k] ? fusionner(a[k], v) : v;
    return out;
  }
  function liste(v) { if (v == null) return []; return Array.isArray(v) ? v : [v]; }
  function normaliserService(n, s, p, fs) {
    const svc = { nom: n, brut: s, image: s.image || `${p.nom}-${n}`, build: s.build ? (typeof s.build === "string" ? { context: s.build } : s.build) : null,
      command: s.command == null ? null : Array.isArray(s.command) ? s.command.map(String) : decouperCommande(s.command),
      entrypoint: s.entrypoint == null ? undefined : Array.isArray(s.entrypoint) ? s.entrypoint.map(String) : decouperCommande(s.entrypoint),
      environment: {}, ports: [], volumes: [], reseaux: {}, depends_on: {}, secrets: [], healthcheck: null,
      restart: s.restart || null, user: s.user != null ? String(s.user) : null, working_dir: s.working_dir || null, read_only: !!s.read_only,
      tmpfs: liste(s.tmpfs), cap_add: liste(s.cap_add), cap_drop: liste(s.cap_drop), security_opt: liste(s.security_opt),
      mem_limit: s.mem_limit || (s.deploy && s.deploy.resources && s.deploy.resources.limits && s.deploy.resources.limits.memory) || null,
      pids_limit: s.pids_limit || (s.deploy && s.deploy.resources && s.deploy.resources.limits && s.deploy.resources.limits.pids) || null,
      cpus: s.cpus || (s.deploy && s.deploy.resources && s.deploy.resources.limits && s.deploy.resources.limits.cpus) || null,
      container_name: s.container_name || null, hostname: s.hostname || null, labels: s.labels || {}, replicas: (s.deploy && s.deploy.replicas) || 1, privileged: !!s.privileged };
    if (Array.isArray(s.environment)) s.environment.forEach((e) => { const k = String(e).indexOf("="); if (k < 0) svc.environment[e] = p.env[e]; else svc.environment[String(e).slice(0, k)] = String(e).slice(k + 1); });
    else Object.entries(s.environment || {}).forEach(([k, v]) => { svc.environment[k] = v == null ? p.env[k] : String(v); });
    for (const ef of liste(s.env_file)) { const f = fs.lire(chemin.norm(typeof ef === "string" ? ef : ef.path, p.dossier)); if (f.err) return { erreur: `env file ${chemin.norm(typeof ef === "string" ? ef : ef.path, p.dossier)} not found: stat ${chemin.norm(typeof ef === "string" ? ef : ef.path, p.dossier)}: no such file or directory` }; f.contenu.split("\n").forEach((l) => { const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(l); if (m && svc.environment[m[1]] === undefined) svc.environment[m[1]] = m[2]; }); }
    for (const pt of liste(s.ports)) {
      if (typeof pt === "object") { svc.ports.push({ ip: pt.host_ip || "0.0.0.0", hote: String(pt.published || ""), ctn: String(pt.target), proto: pt.protocol || "tcp" }); continue; }
      const [spec, proto] = String(pt).split("/"); const parts = spec.split(":");
      const [ip, hote, ctn] = parts.length === 3 ? parts : parts.length === 2 ? ["0.0.0.0", parts[0], parts[1]] : ["0.0.0.0", "", parts[0]];
      svc.ports.push({ ip, hote, ctn, proto: proto || "tcp", hoteVide: !hote });
    }
    for (const v of liste(s.volumes)) {
      if (typeof v === "object") { svc.volumes.push({ type: v.type || "volume", source: v.source, cible: v.target, ro: !!v.read_only }); continue; }
      const parts = String(v).split(":");
      if (parts.length === 1) svc.volumes.push({ type: "volume", source: "", cible: parts[0], ro: false });
      else svc.volumes.push({ type: /^[./~]/.test(parts[0]) ? "bind" : "volume", source: parts[0], cible: parts[1], ro: (parts[2] || "").split(",").includes("ro") });
    }
    if (s.networks) { if (Array.isArray(s.networks)) s.networks.forEach((r) => { svc.reseaux[r] = {}; }); else Object.keys(s.networks).forEach((r) => { svc.reseaux[r] = s.networks[r] || {}; }); }
    else if (!s.network_mode) svc.reseaux.default = {};
    if (Array.isArray(s.depends_on)) s.depends_on.forEach((d) => { svc.depends_on[d] = { condition: "service_started", required: true }; });
    else Object.entries(s.depends_on || {}).forEach(([d, v]) => { svc.depends_on[d] = { condition: (v && v.condition) || "service_started", required: v && v.required === false ? false : true }; });
    for (const sc of liste(s.secrets)) svc.secrets.push(typeof sc === "string" ? { source: sc, target: "/run/secrets/" + sc } : { source: sc.source, target: sc.target ? (sc.target.startsWith("/") ? sc.target : "/run/secrets/" + sc.target) : "/run/secrets/" + sc.source });
    if (s.healthcheck) {
      const h = s.healthcheck;
      if (h.disable) svc.healthcheck = { Test: ["NONE"] };
      else if (h.test) {
        const t = typeof h.test === "string" ? ["CMD-SHELL", h.test] : h.test.map(String);
        svc.healthcheck = { Test: t, Interval: D.dureeMs(h.interval || "30s"), Timeout: D.dureeMs(h.timeout || "30s"), Retries: h.retries != null ? h.retries : 3, StartPeriod: D.dureeMs(h.start_period || "0s"), brut: h };
      }
    }
    return svc;
  }

  /* --------------------------------------------------------- utilitaires */
  const conteneursDe = (m, p, svc) => m.conteneurs.filter((c) => c.labels["com.docker.compose.project"] === p.nom && (!svc || c.labels["com.docker.compose.service"] === svc) && c.labels["com.docker.compose.oneoff"] !== "True")
    .sort((a, b) => +a.labels["com.docker.compose.container-number"] - +b.labels["com.docker.compose.container-number"]);
  function ordreDependances(p, cibles) {
    const ordre = []; const vus = new Set();
    const visiter = (n) => { if (vus.has(n)) return; vus.add(n); Object.keys(p.services[n].depends_on).forEach(visiter); ordre.push(n); };
    (cibles && cibles.length ? cibles : Object.keys(p.services)).forEach(visiter);
    return ordre;
  }
  function niveaux(p, noms) {
    const niv = {};
    const calc = (n) => { if (niv[n] !== undefined) return niv[n]; const deps = Object.keys(p.services[n].depends_on).filter((d) => noms.includes(d)); niv[n] = deps.length ? 1 + Math.max(...deps.map(calc)) : 0; return niv[n]; };
    noms.forEach(calc);
    const groupes = [];
    noms.forEach((n) => { (groupes[niv[n]] = groupes[niv[n]] || []).push(n); });
    return groupes.filter(Boolean);
  }
  const hashSvc = (svc) => D.hexDe(JSON.stringify([svc.brut, svc.environment, svc.ports]), 64);
  const ligne = (t, d) => ({ t: " " + t + " ", e: true, d });

  // Options de conteneur pour un service.
  function optionsConteneur(p, svc, numero) {
    const nom = svc.container_name || `${p.nom}-${svc.nom}-${numero}`;
    const premierReseau = Object.keys(svc.reseaux)[0];
    const o = {
      nom, imageTapee: svc.image, cmd: svc.command || [], entrypoint: svc.entrypoint === undefined ? undefined : (svc.entrypoint.length ? svc.entrypoint.join(" ") : ""),
      env: Object.entries(svc.environment).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`),
      vols: svc.volumes.map((v) => (v.type === "bind" ? `${chemin.norm(v.source.replace(/^~/, "/home/eleve"), p.dossier)}:${v.cible}${v.ro ? ":ro" : ""}` : `${v.source ? (p.volumes[v.source] ? p.volumes[v.source].nom : `${p.nom}_${v.source}`) : ""}:${v.cible}${v.ro ? ":ro" : ""}`.replace(/^:/, ""))),
      ports: svc.ports.map((pt) => ({ ...pt, hote: pt.hote || String(32768 + Math.floor(Math.random() * 1000)) })),
      reseau: premierReseau ? p.reseaux[premierReseau].nom : "none", reseauxSup: Object.keys(svc.reseaux).slice(1).map((r) => p.reseaux[r].nom),
      aliases: [svc.nom], labels: { "com.docker.compose.project": p.nom, "com.docker.compose.service": svc.nom, "com.docker.compose.container-number": String(numero), "com.docker.compose.config-hash": hashSvc(svc), "com.docker.compose.oneoff": "False", "com.docker.compose.project.working_dir": p.dossier, "com.docker.compose.version": VERSION.slice(1) },
      health: svc.healthcheck ? { ...svc.healthcheck } : undefined, restart: svc.restart ? (() => { const [n, max] = svc.restart.split(":"); return { Name: n, MaximumRetryCount: parseInt(max || "0", 10) }; })() : undefined,
      user: svc.user, workdir: svc.working_dir, readOnly: svc.read_only, tmpfs: svc.tmpfs.length ? Object.fromEntries(svc.tmpfs.map((t) => { const [d, op] = String(t).split(/:(.*)/s); return [d, op || ""]; })) : null,
      capAdd: svc.cap_add, capDrop: svc.cap_drop, securityOpt: svc.security_opt, memoire: svc.mem_limit ? O.lireTaille(svc.mem_limit) : 0, pids: svc.pids_limit ? parseInt(svc.pids_limit, 10) : 0, cpus: svc.cpus ? parseFloat(svc.cpus) : 0,
      hostname: svc.hostname, privileged: svc.privileged,
      secrets: svc.secrets.map((sc) => ({ source: p.secrets[sc.source].fichier, dest: sc.target })),
    };
    if (o.health) delete o.health.brut;
    return o;
  }
  // Attend (en temps virtuel) qu'une condition soit remplie ; renvoie {ok, pause}.
  function attendre(m, test, maxMs = 180000) {
    let pause = 0;
    for (let k = 0; k < 400 && pause < maxMs; k++) {
      const r = test(); if (r !== null) return { r, pause };
      const prochains = m.conteneurs.flatMap((c) => [c.etat === "running" && c.proc && c.proc.type === "script" ? c.proc.reveil : Infinity, c.etat === "running" && c.health ? c.health.prochain : Infinity, c.etat === "restarting" ? c.relanceA : Infinity]).filter((t) => t > H.now() && t !== Infinity);
      const pas = prochains.length ? Math.min(...prochains) - H.now() + 1 : 1000;
      H.avancer(pas); pause += pas;
    }
    return { r: test(), pause };
  }

  /* ---------------------------------------------------------- commandes */
  const C = {};
  C.up = function (m, p, args, x) {
    const { o, ops } = SIM.options(args, ["scale", "t", "timeout", "pull"]);
    const echelles = {};
    args.forEach((a, k) => { if (a === "--scale") { const [s, n] = args[k + 1].split("="); echelles[s] = parseInt(n, 10); } else if (a.startsWith("--scale=")) { const [s, n] = a.slice(8).split("="); echelles[s] = parseInt(n, 10); } });
    for (const s of ops) if (!p.services[s]) return R.err(`no such service: ${s}`, 1);
    const noms = ordreDependances(p, ops);
    const l = [];
    // Images à tirer ou construire.
    for (const n of noms) {
      const svc = p.services[n];
      if (svc.build && (!m.image(svc.image) || o.build)) {
        const ctx = chemin.norm(svc.build.context || ".", p.dossier);
        const r = DOCKER.build(m, ["-t", svc.image].concat(svc.build.dockerfile ? ["-f", chemin.norm(svc.build.dockerfile, ctx)] : []).concat([ctx]), x);
        l.push(...r.l.filter((y) => y.pause !== undefined || true));
        if (r.code) return { l, code: r.code };
        l.push(ligne(`Image ${svc.image} Built`));
      } else if (!m.image(svc.image)) {
        l.push(ligne(`Image ${svc.image} Pulling`));
        const tmp = []; const im = m.tirer(svc.image, tmp, { explicite: true });
        if (!im) { l.push(ligne(`Image ${svc.image} Error pull access denied for ${D.Moteur.ref(svc.image).repo}, repository does not exist or may require 'docker login'`)); l.push({ t: `Error response from daemon: pull access denied for ${D.Moteur.ref(svc.image).repo}, repository does not exist or may require 'docker login'`, e: true }); return { l, code: 1 }; }
        l.push({ pause: 800 + Math.random() * 1200 }, ligne(`Image ${svc.image} Pulled`));
      }
    }
    // Réseaux et volumes.
    const reseaux = new Set(noms.flatMap((n) => Object.keys(p.services[n].reseaux)));
    for (const r of reseaux) {
      const def = p.reseaux[r];
      if (!def) return R.err(`service "${noms.find((n) => p.services[n].reseaux[r])}" refers to undefined network ${r}: invalid compose project`, 1);
      if (!m.reseaux[def.nom]) {
        if (def.externe) return R.err(`network ${def.nom} declared as external, but could not be found`, 1);
        l.push(ligne(`Network ${def.nom} Creating`), ligne(`Network ${def.nom} Creating`));
        m.creerReseau(def.nom, { labels: { "com.docker.compose.project": p.nom, "com.docker.compose.network": r }, interne: def.interne });
        l.push(ligne(`Network ${def.nom} Created`), ligne(`Network ${def.nom} Created`));
      }
    }
    for (const [, v] of Object.entries(p.volumes)) {
      if (!m.volumes[v.nom] && !v.externe) { l.push(ligne(`Volume ${v.nom} Creating`), ligne(`Volume ${v.nom} Creating`)); m.creerVolume(v.nom, { labels: { "com.docker.compose.project": p.nom } }); l.push(ligne(`Volume ${v.nom} Created`), ligne(`Volume ${v.nom} Created`)); }
    }
    for (const n of noms) for (const sc of p.services[n].secrets) { const f = p.secrets[sc.source]; if (f.fichier && !m.hote.fs.stat(f.fichier)) return R.err(`secret file ${f.fichier} not found: stat ${f.fichier}: no such file or directory`, 1); }
    // Conteneurs, niveau de dépendance par niveau.
    const groupes = niveaux(p, noms);
    const plan = [];
    for (const groupe of groupes) {
      const actions = [];
      for (const n of groupe) {
        const svc = p.services[n];
        const voulu = echelles[n] !== undefined ? echelles[n] : svc.replicas;
        const existants = conteneursDe(m, p, n);
        const h = hashSvc(svc);
        for (let k = 1; k <= Math.max(voulu, existants.length); k++) {
          const c = existants.find((y) => +y.labels["com.docker.compose.container-number"] === k);
          if (k > voulu) { if (c) actions.push({ type: "retirer", c, n }); continue; }
          if (!c) actions.push({ type: "creer", n, k });
          else if (c.labels["com.docker.compose.config-hash"] !== h || o["force-recreate"]) actions.push({ type: "recreer", c, n, k });
          else if (c.etat === "running") actions.push({ type: "tourne", c, n });
          else actions.push({ type: "demarrer", c, n });
        }
      }
      plan.push(actions);
    }
    let code = 0;
    const creesParNiveau = [];
    for (const actions of plan) {
      // Création (ou recréation) de tous les niveaux d'abord, puis démarrage niveau par niveau.
      for (const a of actions) {
        if (a.type === "tourne") l.push(ligne(`Container ${a.c.nom} Running`));
        if (a.type === "retirer") { l.push(ligne(`Container ${a.c.nom} Stopping`)); const d = D.arreter(m, a.c); l.push({ pause: d }, ligne(`Container ${a.c.nom} Stopped`), ligne(`Container ${a.c.nom} Removing`)); m.conteneurs = m.conteneurs.filter((y) => y !== a.c); l.push(ligne(`Container ${a.c.nom} Removed`)); }
      }
      const crees = [];
      actions.filter((a) => a.type === "creer").forEach((a) => l.push(ligne(`Container ${optionsConteneur(p, p.services[a.n], a.k).nom} Creating`)));
      for (const a of actions) {
        if (a.type === "creer") { const c = m.creer(m.image(p.services[a.n].image), optionsConteneur(p, p.services[a.n], a.k)); crees.push({ c, a }); }
        if (a.type === "recreer") {
          l.push(ligne(`Container ${a.c.nom} Recreate`));
          if (a.c.etat === "running") { const d = D.arreter(m, a.c); if (d) l.push({ pause: Math.min(d, 1500) }); }
          m.conteneurs = m.conteneurs.filter((y) => y !== a.c);
          const c = m.creer(m.image(p.services[a.n].image), optionsConteneur(p, p.services[a.n], a.k));
          l.push(ligne(`Container ${c.nom} Recreated`));
          crees.push({ c, a });
        }
        if (a.type === "demarrer") crees.push({ c: a.c, a });
      }
      crees.filter((v) => v.a.type === "creer").slice().reverse().forEach((v) => l.push(ligne(`Container ${v.c.nom} Created`)));
      creesParNiveau.push({ actions, crees });
    }
    for (const { actions, crees } of creesParNiveau) {
      const lancer = crees.map((v) => v.c);
      lancer.forEach((c) => l.push(ligne(`Container ${c.nom} Starting`)));
      for (const c of lancer) {
        const err = m.demarrer(c);
        if (err) { l.push({ t: `Error response from daemon: ${err}`, e: true }); code = 1; return { l, code }; }
      }
      lancer.forEach((c) => l.push(ligne(`Container ${c.nom} Started`)));
      // Attente pour le niveau suivant : conditions déclarées par les services dépendants.
      const suivant = plan[plan.indexOf(actions) + 1];
      if (suivant) {
        const conds = {};
        suivant.forEach((a) => Object.entries(p.services[a.n].depends_on).forEach(([d, cd]) => { conds[d] = cd.condition; }));
        for (const [d, cond] of Object.entries(conds)) {
          for (const c of conteneursDe(m, p, d)) {
            if (cond === "service_healthy") {
              l.push(ligne(`Container ${c.nom} Waiting`));
              const res = attendre(m, () => (!c.health ? "sans" : c.health.statut === "healthy" ? "ok" : c.health.statut === "unhealthy" || c.etat !== "running" ? "ko" : null));
              l.push({ pause: res.pause });
              if (res.r === "ko" || res.r === "sans") {
                const svcDep = Object.entries(conds).find(([k]) => k === d);
                l.push(ligne(`Container ${c.nom} Error dependency ${d} failed to start`));
                l.push({ t: res.r === "sans" ? `dependency failed to start: container ${c.nom} has no healthcheck configured` : `dependency failed to start: container ${c.nom} is unhealthy`, e: true });
                void svcDep; return { l, code: 1 };
              }
              l.push(ligne(`Container ${c.nom} Healthy`));
            } else if (cond === "service_completed_successfully") {
              l.push(ligne(`Container ${c.nom} Waiting`));
              const res = attendre(m, () => (c.etat === "exited" ? (c.code === 0 ? "ok" : "ko") : null));
              l.push({ pause: res.pause });
              if (res.r !== "ok") { l.push({ t: `service "${d}" didn't complete successfully: exit ${c.code}`, e: true }); return { l, code: 1 }; }
              l.push(ligne(`Container ${c.nom} Exited`));
            }
          }
        }
      }
    }
    if (o.wait) {
      const cs = noms.flatMap((n) => conteneursDe(m, p, n));
      cs.forEach((c) => l.push(ligne(`Container ${c.nom} Waiting`)));
      const res = attendre(m, () => (cs.every((c) => c.etat === "running" && (!c.health || c.health.statut === "healthy")) ? "ok" : cs.some((c) => c.health && c.health.statut === "unhealthy") ? "ko" : null));
      l.push({ pause: res.pause });
      cs.forEach((c) => l.push(ligne(`Container ${c.nom} ${c.health ? (c.health.statut === "healthy" ? "Healthy" : "Error") : "Running"}`)));
      if (res.r !== "ok") { l.push({ t: `container ${cs.find((c) => c.health && c.health.statut !== "healthy").nom} is unhealthy`, e: true }); return { l, code: 1 }; }
    }
    if (!(o.d || o.detach || o.wait)) {
      l.push(...C.logs(m, p, ops, x).l);
      l.push({ t: "(simulateur : sans -d, Compose resterait attaché aux journaux jusqu'à Ctrl+C. Ici les conteneurs continuent en arrière-plan : utilise docker compose up -d.)", e: true, info: true });
    }
    return { l, code };
  };
  C.down = function (m, p, args) {
    const { o } = SIM.options(args, ["t", "timeout", "rmi"]);
    const l = [];
    const tous = m.conteneurs.filter((c) => c.labels["com.docker.compose.project"] === p.nom);
    const ordre = ordreDependances(p).reverse();
    const groupes = [];
    const parNiveau = niveaux(p, Object.keys(p.services)).reverse();
    parNiveau.forEach((g) => groupes.push(tous.filter((c) => g.includes(c.labels["com.docker.compose.service"]))));
    const orphelins = tous.filter((c) => !p.services[c.labels["com.docker.compose.service"]]);
    if (orphelins.length) groupes.push(orphelins);
    void ordre;
    for (const g of groupes) {
      if (!g.length) continue;
      const tri = g.slice().sort((a, b) => (a.labels["com.docker.compose.service"] < b.labels["com.docker.compose.service"] ? 1 : -1));
      tri.forEach((c) => l.push(ligne(`Container ${c.nom} Stopping`)));
      // Les arrêts se font en parallèle : le plus lent donne la durée.
      const durees = tri.map((c) => ({ c, d: c.etat === "running" ? (["nginx", "httpd", "apache2", "registry", "mariadb"].includes(c.proc && c.proc.serveur) ? c.img.stop || 500 : 10000) : 0 })).sort((a, b) => a.d - b.d);
      let ecoule = 0;
      for (const { c, d } of durees) {
        if (d > ecoule) { l.push({ pause: d - ecoule }); H.avancer(d - ecoule); ecoule = d; }
        if (c.etat === "running" || c.etat === "restarting") { c.arretDemande = true; c.proc = c.proc || {}; c.proc.tFin = H.now(); m.fin(c, d >= 10000 ? 137 : 0); }
        l.push(ligne(`Container ${c.nom} Stopped`), ligne(`Container ${c.nom} Removing`));
        if (o.v || o.volumes) c.montages.filter((v) => v.type === "volume" && m.volumes[v.nom] && m.volumes[v.nom].anonyme).forEach((v) => delete m.volumes[v.nom]);
        m.conteneurs = m.conteneurs.filter((y) => y !== c);
        l.push(ligne(`Container ${c.nom} Removed`));
      }
    }
    if (o.v || o.volumes) for (const v of Object.values(p.volumes)) if (m.volumes[v.nom] && !v.externe) { l.push(ligne(`Volume ${v.nom} Removing`)); delete m.volumes[v.nom]; l.push(ligne(`Volume ${v.nom} Removed`)); }
    for (const r of Object.values(p.reseaux)) {
      if (!m.reseaux[r.nom] || r.externe) continue;
      if (m.conteneurs.some((c) => c.etat === "running" && c.reseaux[r.nom])) { l.push(ligne(`Network ${r.nom} Resource is still in use`)); continue; }
      l.push(ligne(`Network ${r.nom} Removing`)); delete m.reseaux[r.nom]; l.push(ligne(`Network ${r.nom} Removed`));
    }
    if (o.rmi) Object.values(p.services).forEach((s) => { if ((o.rmi === "all" || s.build) && m.image(s.image)) { l.push(ligne(`Image ${s.image} Removing`)); DOCKER.rmi(m, [s.image]); l.push(ligne(`Image ${s.image} Removed`)); } });
    return { l, code: 0 };
  };
  C.ps = function (m, p, args) {
    const { o, ops } = SIM.options(args, ["format", "status", "filter"]);
    let cs = m.conteneurs.filter((c) => c.labels["com.docker.compose.project"] === p.nom && (o.a || o.all || c.etat === "running" || c.etat === "restarting"));
    if (ops.length) cs = cs.filter((c) => ops.includes(c.labels["com.docker.compose.service"]));
    if (o.status) cs = cs.filter((c) => c.etat === o.status);
    cs.sort((a, b) => (a.nom < b.nom ? -1 : 1));
    if (o.services) return R.ok([...new Set(cs.map((c) => c.labels["com.docker.compose.service"]))]);
    if (o.q || o.quiet) return R.ok(cs.map((c) => c.idLong));
    const vues = cs.map((c) => { const v = m.vuePs(c); return { ...v, Name: c.nom, Service: c.labels["com.docker.compose.service"], Project: p.nom, Health: c.health ? c.health.statut : "", ExitCode: c.code, Publishers: c.ports.map((x) => `${x.ip}:${x.hote}->${x.ctn}/${x.proto || "tcp"}`).join(", "), RunningFor: v.RunningFor }; });
    if (o.format === "json") return R.ok(vues.map((v) => JSON.stringify({ Command: v.Command, CreatedAt: v.CreatedAt, ExitCode: v.ExitCode, Health: v.Health, ID: v.ID, Image: v.Image, Name: v.Name, Project: v.Project, Service: v.Service, State: v.State, Status: v.Status })));
    if (o.format) return D.formater(o.format, vues);
    return R.ok(O.tableau([["NAME", "IMAGE", "COMMAND", "SERVICE", "CREATED", "STATUS", "PORTS"]].concat(vues.map((v) => [v.Name, v.Image, v.Command, v.Service, v.RunningFor, v.Status, v.Ports])), 3, 10));
  };
  C.logs = function (m, p, args) {
    const { o, ops } = SIM.options(args, ["n", "tail", "since"]);
    const cs = m.conteneurs.filter((c) => c.labels["com.docker.compose.project"] === p.nom && (!ops.length || ops.includes(c.labels["com.docker.compose.service"])));
    const prefixes = cs.map((c) => `${c.labels["com.docker.compose.service"]}-${c.labels["com.docker.compose.container-number"]}`);
    const larg = Math.max(0, ...prefixes.map((x) => x.length)) + 2;
    let lignes = [];
    cs.forEach((c, k) => { let ls = c.logs; const n = o.n || o.tail; if (n !== undefined && n !== "all") ls = ls.slice(-parseInt(n, 10)); ls.forEach((x, j) => lignes.push({ ts: x.ts, j, t: (o["no-log-prefix"] ? "" : O.pad(prefixes[k], larg) + "| ") + (o.t || o.timestamps ? O.date.iso(x.ts) + " " : "") + x.t, e: x.e })); });
    lignes.sort((a, b) => a.ts - b.ts || a.j - b.j);
    const l = lignes.map((x) => ({ t: x.t, e: x.e }));
    if (o.f || o.follow) l.push({ t: "(simulateur : -f suivrait les journaux en continu ; ici on affiche ce qui existe déjà)", e: true, info: true });
    return { l, code: 0 };
  };
  C.exec = function (m, p, args) {
    let i = 0; const opts = { env: {} }; let index = 1;
    for (; i < args.length && args[i].startsWith("-"); i++) {
      const a = args[i];
      if (a === "-T" || a === "--no-TTY" || a === "-d" || a === "--detach" || a === "-i" || a === "-t" || a === "--privileged") continue;
      if (a === "-u" || a === "--user") { opts.user = args[++i]; continue; }
      if (a === "-w" || a === "--workdir") { opts.workdir = args[++i]; continue; }
      if (a === "-e" || a === "--env") { const v = args[++i]; const k = v.indexOf("="); opts.env[v.slice(0, k)] = v.slice(k + 1); continue; }
      if (a === "--index") { index = parseInt(args[++i], 10); continue; }
      return R.err(`unknown flag: ${a}`, 1);
    }
    const svc = args[i]; const prog = args.slice(i + 1);
    if (!svc) return R.err("'docker compose exec' requires at least 2 arguments", 1);
    if (!p.services[svc]) return R.err(`service "${svc}" is not running`, 1);
    const c = conteneursDe(m, p, svc).find((y) => +y.labels["com.docker.compose.container-number"] === index);
    if (!c || c.etat !== "running") return R.err(`service "${svc}" is not running`, 1);
    if (!prog.length) return R.err("'docker compose exec' requires at least 2 arguments", 1);
    return D.executerDans(m, c, prog, opts);
  };
  C.run = function (m, p, args, x) {
    const { o, ops } = SIM.options(args, ["e", "u", "w", "name", "entrypoint"]);
    const svc = p.services[ops[0]];
    if (!svc) return R.err(`no such service: ${ops[0]}`, 1);
    const opts = optionsConteneur(p, svc, 1);
    opts.nom = o.name || `${p.nom}-${svc.nom}-run-${O.hex(12)}`; opts.labels["com.docker.compose.oneoff"] = "True"; opts.ports = o["service-ports"] ? opts.ports : []; opts.rm = !!o.rm;
    if (ops.length > 1) opts.cmd = ops.slice(1);
    const l = [];
    if (!m.image(svc.image)) m.tirer(svc.image, [], { explicite: true });
    for (const r of Object.keys(svc.reseaux)) if (!m.reseaux[p.reseaux[r].nom]) { l.push(ligne(`Network ${p.reseaux[r].nom} Creating`), ligne(`Network ${p.reseaux[r].nom} Created`)); m.creerReseau(p.reseaux[r].nom, { labels: { "com.docker.compose.project": p.nom } }); }
    const c = m.creer(m.image(svc.image), opts);
    const err = m.demarrer(c);
    if (err) return R.err(`Error response from daemon: ${err}`, 1);
    let lus = 0; c.garder = true;
    for (let k = 0; k < 200 && c.etat === "running"; k++) { const pr = c.proc; if (!pr || pr.type !== "script" || pr.reveil === Infinity) break; const d = pr.reveil - H.now(); if (d > 0) { l.push({ pause: d }); H.avancer(d); } else m.avancer(c, H.now()); }
    for (; lus < c.logs.length; lus++) l.push({ t: c.logs[lus].t, e: c.logs[lus].e });
    c.garder = false;
    const code = c.etat === "exited" ? c.code : 0;
    if (opts.rm && c.etat === "exited") m.conteneurs = m.conteneurs.filter((y) => y !== c);
    return { l, code };
  };
  C.stop = function (m, p, args) {
    const { ops } = SIM.options(args, ["t"]);
    const l = [];
    m.conteneurs.filter((c) => c.labels["com.docker.compose.project"] === p.nom && (!ops.length || ops.includes(c.labels["com.docker.compose.service"])) && c.etat === "running").forEach((c) => { l.push(ligne(`Container ${c.nom} Stopping`)); const d = D.arreter(m, c); if (d) l.push({ pause: d }); l.push(ligne(`Container ${c.nom} Stopped`)); });
    return { l, code: 0 };
  };
  C.start = function (m, p, args) {
    const { ops } = SIM.options(args);
    const l = [];
    conteneursDe(m, p).filter((c) => (!ops.length || ops.includes(c.labels["com.docker.compose.service"])) && c.etat !== "running").forEach((c) => { l.push(ligne(`Container ${c.nom} Starting`)); m.demarrer(c); l.push(ligne(`Container ${c.nom} Started`)); });
    return { l, code: 0 };
  };
  C.restart = function (m, p, args) {
    const { ops } = SIM.options(args, ["t"]);
    const l = [];
    conteneursDe(m, p).filter((c) => !ops.length || ops.includes(c.labels["com.docker.compose.service"])).forEach((c) => { l.push(ligne(`Container ${c.nom} Restarting`)); const d = D.arreter(m, c); if (d) l.push({ pause: d }); m.demarrer(c); l.push(ligne(`Container ${c.nom} Started`)); });
    return { l, code: 0 };
  };
  C.rm = function (m, p, args) {
    const { o, ops } = SIM.options(args);
    const l = [];
    const cs = conteneursDe(m, p).filter((c) => (!ops.length || ops.includes(c.labels["com.docker.compose.service"])) && (c.etat !== "running" || o.s || o.stop));
    if (!cs.length) return R.err("No stopped containers", 0);
    cs.forEach((c) => { if (c.etat === "running") D.arreter(m, c); l.push(ligne(`Container ${c.nom} Removing`)); m.conteneurs = m.conteneurs.filter((y) => y !== c); l.push(ligne(`Container ${c.nom} Removed`)); });
    return { l, code: 0 };
  };
  C.top = function (m, p) {
    const l = [];
    conteneursDe(m, p).filter((c) => c.etat === "running").forEach((c, k) => { if (k) l.push({ t: "" }); l.push({ t: c.nom }); l.push(...DOCKER.top(m, [c.nom]).l); });
    return { l, code: 0 };
  };
  C.images = function (m, p) {
    const cs = conteneursDe(m, p);
    return R.ok(O.tableau([["CONTAINER", "REPOSITORY", "TAG", "PLATFORM", "IMAGE ID", "SIZE", "CREATED"]].concat(cs.map((c) => { const r = D.Moteur.ref(c.image); return [c.nom, r.repo, r.tag, "linux/amd64", c.img.id.slice(0, 12), O.tailleDocker(c.img.disque), O.duree(H.now() - c.img.cree) + " ago"]; })), 3, 10));
  };
  C.pull = function (m, p) {
    const l = [];
    Object.values(p.services).forEach((s) => { if (s.build) return; l.push(ligne(`Image ${s.image} Pulling`)); m.tirer(s.image, [], { explicite: true }); l.push({ pause: 600 }, ligne(`Image ${s.image} Pulled`)); });
    return { l, code: 0 };
  };
  C.build = function (m, p, args, x) {
    const l = [];
    for (const s of Object.values(p.services)) { if (!s.build) continue; const ctx = chemin.norm(s.build.context || ".", p.dossier); const r = DOCKER.build(m, ["-t", s.image].concat(s.build.dockerfile ? ["-f", chemin.norm(s.build.dockerfile, ctx)] : []).concat([ctx]), x); l.push(...r.l); if (r.code) return { l, code: r.code }; l.push(ligne(`Image ${s.image} Built`)); }
    return { l, code: 0 };
  };
  C.config = function (m, p, args) {
    const { o } = SIM.options(args, ["format"]);
    if (o.services) return R.ok(Object.keys(p.services).sort());
    if (o.volumes) return R.ok(Object.keys(p.volumes).sort());
    if (o.networks) return R.ok(Object.keys(p.reseaux).sort());
    if (o.images) return R.ok(Object.values(p.services).map((s) => s.image));
    if (o.q || o.quiet) return R.ok();
    return R.ok(dump(normaliser(p)).replace(/\n$/, "").split("\n"));
  };
  C.ls = function (m) {
    const projets = {};
    m.conteneurs.forEach((c) => { const n = c.labels["com.docker.compose.project"]; if (!n) return; projets[n] = projets[n] || { n, run: 0, tot: 0, dir: c.labels["com.docker.compose.project.working_dir"] }; projets[n].tot++; if (c.etat === "running") projets[n].run++; });
    return R.ok(O.tableau([["NAME", "STATUS", "CONFIG FILES"]].concat(Object.values(projets).map((v) => [v.n, v.run ? `running(${v.run})` : `exited(${v.tot})`, v.dir + "/compose.yaml"])), 3, 10));
  };
  C.version = () => R.ok(`Docker Compose version ${VERSION}`);

  /* ------------------------------------------- docker compose config (YAML) */
  function normaliser(p) {
    const services = {};
    for (const n of Object.keys(p.services).sort()) {
      const s = p.services[n]; const b = s.brut; const o = {};
      if (s.command) o.command = s.command;
      if (s.container_name) o.container_name = s.container_name;
      if (Object.keys(s.depends_on).length) o.depends_on = Object.fromEntries(Object.entries(s.depends_on).map(([d, v]) => [d, { condition: v.condition, required: v.required }]));
      if (s.entrypoint) o.entrypoint = s.entrypoint;
      if (Object.keys(s.environment).length) o.environment = Object.fromEntries(Object.entries(s.environment).sort());
      if (b.healthcheck) { const h = b.healthcheck; o.healthcheck = {}; if (h.test) o.healthcheck.test = typeof h.test === "string" ? ["CMD-SHELL", h.test] : h.test; ["timeout", "interval"].forEach((k) => { if (h[k]) o.healthcheck[k] = h[k]; }); if (h.retries != null) o.healthcheck.retries = h.retries; if (h.start_period) o.healthcheck.start_period = h.start_period; }
      o.image = s.image;
      o.networks = Object.fromEntries(Object.keys(s.reseaux).map((r) => [r, null]));
      if (s.ports.length) o.ports = s.ports.map((pt) => ({ mode: "ingress", ...(pt.ip !== "0.0.0.0" ? { host_ip: pt.ip } : {}), target: +pt.ctn, ...(pt.hote ? { published: String(pt.hote) } : {}), protocol: pt.proto }));
      if (s.read_only) o.read_only = true;
      if (s.restart) o.restart = s.restart;
      if (s.secrets.length) o.secrets = s.secrets.map((x) => ({ source: x.source, target: x.target }));
      if (s.user) o.user = s.user;
      if (s.volumes.length) o.volumes = s.volumes.map((v) => (v.type === "bind" ? { type: "bind", source: chemin.norm(v.source, p.dossier), target: v.cible, ...(v.ro ? { read_only: true } : {}), bind: {} } : { type: "volume", source: v.source, target: v.cible, ...(v.ro ? { read_only: true } : {}), volume: {} }));
      services[n] = o;
    }
    const out = { name: p.nom, services };
    if (Object.keys(p.reseaux).length) out.networks = Object.fromEntries(Object.entries(p.reseaux).map(([n, r]) => [n, { name: r.nom }]));
    if (Object.keys(p.volumes).length) out.volumes = Object.fromEntries(Object.entries(p.volumes).map(([n, v]) => [n, { name: v.nom }]));
    if (Object.keys(p.secrets).length) out.secrets = Object.fromEntries(Object.entries(p.secrets).map(([n, v]) => [n, v.fichier ? { name: `${p.nom}_${n}`, file: v.fichier } : { name: `${p.nom}_${n}`, environment: v.env }]));
    return out;
  }
  // YAML à la manière de Go (gopkg.in/yaml.v3) : 2 espaces, listes en retrait, guillemets doubles si besoin.
  function scalaire(v) {
    if (v === null) return "null";
    if (typeof v === "boolean" || typeof v === "number") return String(v);
    const s = String(v).replace(/\$/g, "$$$$");
    if (s === "" || /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s) || /^0x[0-9a-f]+$/i.test(s) || /^(true|false|null|yes|no|on|off|~)$/i.test(s) || /^[\s#&*!|>'"%@`{[,?:-]/.test(s) || /[:#]\s|:$|\s$/.test(s) || /\n/.test(s)) return JSON.stringify(s);
    return s;
  }
  function dump(v, ind = "") {
    if (Array.isArray(v)) return v.map((x) => (x !== null && typeof x === "object" ? `${ind}- ${dump(x, ind + "  ").replace(/^\s+/, "")}` : `${ind}- ${scalaire(x)}\n`)).join("");
    let out = "";
    for (const [k, x] of Object.entries(v)) {
      if (x !== null && typeof x === "object" && !(Array.isArray(x) && !x.length) && !(!Array.isArray(x) && !Object.keys(x).length)) out += `${ind}${k}:\n${dump(x, ind + "  ")}`;
      else out += `${ind}${k}: ${x !== null && typeof x === "object" ? (Array.isArray(x) ? "[]" : "{}") : scalaire(x)}\n`;
    }
    return out;
  }

  /* -------------------------------------------------------- point d'entrée */
  DOCKER.compose = function (m, args, x) {
    const o = { fichiers: [], projet: null, dossier: null };
    let i = 0;
    for (; i < args.length && args[i].startsWith("-"); i++) {
      const a = args[i];
      if (a === "-f" || a === "--file") o.fichiers.push(args[++i]);
      else if (a.startsWith("--file=")) o.fichiers.push(a.slice(7));
      else if (a === "-p" || a === "--project-name") o.projet = args[++i];
      else if (a === "--project-directory") o.dossier = args[++i];
      else if (a === "--env-file" || a === "--profile" || a === "--ansi" || a === "--progress") i++;
      else if (a === "--version" || a === "-v") return C.version();
      else if (a === "--help" || a === "-h") break;
      else return R.err(`unknown flag: ${a}`, 1);
    }
    const sous = args[i]; const r = args.slice(i + 1);
    if (!sous || sous === "--help" || sous === "help") return R.ok(["", "Usage:  docker compose [OPTIONS] COMMAND", "", "Define and run multi-container applications with Docker", "", "Commands:", "  build       Build or rebuild services", "  config      Parse, resolve and render compose file in canonical format", "  down        Stop and remove containers, networks", "  exec        Execute a command in a running container", "  images      List images used by the created containers", "  logs        View output from containers", "  ls          List running compose projects", "  ps          List containers", "  pull        Pull service images", "  restart     Restart service containers", "  rm          Removes stopped service containers", "  run         Run a one-off command on a service", "  start       Start services", "  stop        Stop services", "  top         Display the running processes", "  up          Create and start containers", "  version     Show the Docker Compose version information"]);
    if (sous === "version") return C.version();
    if (sous === "ls") return C.ls(m);
    if (!C[sous]) return R.err([`unknown docker command: "compose ${sous}"`], 1);
    if (!G.jsyaml) return R.err("(simulateur : la bibliothèque YAML n'a pas pu être chargée ; recharge la page.)", 1);
    const p = charger(m, x, o);
    if (p.erreur) {
      // ps et down sans fichier : Compose se rabat sur le nom du dossier.
      if ((sous === "ps" || sous === "down" || sous === "logs") && p.erreur.startsWith("no configuration file") && o.projet) return C[sous](m, { nom: o.projet, services: {}, reseaux: {}, volumes: {} }, r, x);
      return R.err(p.erreur, 1);
    }
    return C[sous](m, p, r, x);
  };
  SIM.compose = { charger, interpoler };
})(typeof window !== "undefined" ? window : globalThis);
