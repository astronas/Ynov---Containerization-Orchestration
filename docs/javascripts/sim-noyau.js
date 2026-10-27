/* Simulateur, noyau commun : outils, horloge virtuelle, systèmes de fichiers en mémoire,
 * interpréteur shell (tubes, redirections, heredocs, $(...), for, &&, ||, &) et commandes Unix.
 * Les modules sim-docker.js, sim-compose.js et sim-k8s.js s'y branchent via SIM. */
(function (G) {
  "use strict";
  const SIM = (G.SIM = G.SIM || {});

  /* ------------------------------------------------------------------ outils */
  const O = (SIM.outils = {});
  O.hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  O.pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));
  O.padG = (s, n) => " ".repeat(Math.max(0, n - String(s).length)) + String(s);
  O.octets = (s) => new TextEncoder().encode(String(s)).length;
  O.entre = (a, b) => a + Math.random() * (b - a);

  // Durées « humaines » de Docker (units.HumanDuration).
  O.duree = function (ms) {
    const s = Math.floor(ms / 1000);
    if (s < 1) return "Less than a second";
    if (s === 1) return "1 second";
    if (s < 60) return s + " seconds";
    const m = Math.floor(ms / 60000);
    if (m === 1) return "About a minute";
    if (m < 60) return m + " minutes";
    const h = Math.round(ms / 3600000);
    if (h === 1) return "About an hour";
    if (h < 48) return h + " hours";
    return Math.floor(h / 24) + " days";
  };
  // Tailles décimales de Docker (units.HumanSizeWithPrecision).
  O.tailleDocker = function (n, precision = 3) {
    const unites = ["B", "kB", "MB", "GB", "TB"];
    let i = 0; let v = n;
    while (v >= 1000 && i < unites.length - 1) { v /= 1000; i++; }
    return Number(v.toPrecision(precision)) + unites[i];
  };
  // Tailles binaires de du -h / ls -h (GNU) : 4.0K, 50M.
  O.tailleGnu = function (n) {
    if (n < 1024) return String(n);
    const unites = ["K", "M", "G", "T"]; let i = -1; let v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < unites.length - 1);
    return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + unites[i];
  };
  O.lireTaille = function (v) {
    const m = /^(\d+(?:\.\d+)?)\s*([bkmgt]?)i?b?$/i.exec(String(v).trim());
    if (!m) return NaN;
    return Math.round(parseFloat(m[1]) * { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()]);
  };
  // Alignement façon tabwriter de Docker : colonnes séparées d'au moins 3 espaces.
  O.tableau = function (lignes, ecart = 3, min = 0) {
    const larg = [];
    lignes.forEach((l) => l.forEach((c, i) => { larg[i] = Math.max(larg[i] || 0, [...String(c)].length); }));
    return lignes.map((l) => l.map((c, i) => (i === l.length - 1 ? String(c) : O.pad(c, Math.max(larg[i] + ecart, min) + String(c).length - [...String(c)].length))).join(""));
  };
  // Guillemets à la Go (strconv.Quote) et coupe à la Docker (Ellipsis).
  O.quoteGo = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
  O.ellipse = (s, n) => { const c = [...String(s)]; return c.length <= n ? String(s) : c.slice(0, n - 1).join("") + "…"; };
  // Repasse une liste d'arguments en ligne de commande lisible (args avec espaces entre apostrophes).
  O.joindreArgs = (args) => args.map((a) => (a === "" ? "''" : /[\s"'$;&|<>*?()\\]/.test(a) ? "'" + a.replace(/'/g, "'\\''") + "'" : a)).join(" ");

  // Dates : on reste en UTC, comme un serveur.
  const JOURS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MOIS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d2 = (n) => String(n).padStart(2, "0");
  O.date = {
    unix: (t) => { const d = new Date(t); return `${JOURS[d.getUTCDay()]} ${MOIS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${d2(d.getUTCHours())}:${d2(d.getUTCMinutes())}:${d2(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`; },
    hms: (t) => { const d = new Date(t); return `${d2(d.getUTCHours())}:${d2(d.getUTCMinutes())}:${d2(d.getUTCSeconds())}`; },
    nginx: (t) => { const d = new Date(t); return `${d.getUTCFullYear()}/${d2(d.getUTCMonth() + 1)}/${d2(d.getUTCDate())} ${O.date.hms(t)}`; },
    clf: (t) => { const d = new Date(t); return `${d2(d.getUTCDate())}/${MOIS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${O.date.hms(t)} +0000`; },
    python: (t) => { const d = new Date(t); return `${d2(d.getUTCDate())}/${MOIS[d.getUTCMonth()]}/${d.getUTCFullYear()} ${O.date.hms(t)}`; },
    apache: (t) => { const d = new Date(t); return `${JOURS[d.getUTCDay()]} ${MOIS[d.getUTCMonth()]} ${d2(d.getUTCDate())} ${O.date.hms(t)}.${String(d.getUTCMilliseconds()).padStart(3, "0")}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")} ${d.getUTCFullYear()}`; },
    ls: (t) => { const d = new Date(t); return `${MOIS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${d2(d.getUTCHours())}:${d2(d.getUTCMinutes())}`; },
    iso: (t) => new Date(t).toISOString(),
    http: (t) => new Date(t).toUTCString(),
  };

  /* ------------------------------------------------------- horloge virtuelle */
  // `sleep 25` fait avancer le temps de 25 s ; le terminal n'en attend qu'une partie en vrai.
  const H = (SIM.horloge = {
    decalage: 0, fige: null,
    now() { return this.fige !== null ? this.fige : Date.now() + this.decalage; },
    avancer(ms) { this.decalage += ms; SIM.tic(); },
  });
  const tics = [];
  SIM.surTic = (fn) => tics.push(fn);
  let enTic = false;
  SIM.tic = () => { if (enTic || H.fige !== null) return; enTic = true; try { tics.forEach((fn) => fn(H.now())); } finally { enTic = false; } };

  /* ------------------------------------------------------ lignes de sortie */
  // Une sortie est une liste d'éléments : {t: texte, e: erreur?} ou {pause: ms} (temps virtuel écoulé).
  const R = (SIM.R = {
    ok: (lignes = [], code = 0) => ({ l: [].concat(lignes).filter((x) => x !== undefined && x !== null).map((x) => (typeof x === "string" ? { t: x } : x)), code }),
    err: (lignes, code = 1) => ({ l: [].concat(lignes).map((x) => (typeof x === "string" ? { t: x, e: true } : x)), code }),
    textes: (l) => l.filter((x) => x.t !== undefined && !x.e).map((x) => x.t),
  });

  /* ------------------------------------------------ système de fichiers */
  const MSG = { ENOENT: "No such file or directory", EROFS: "Read-only file system", EISDIR: "Is a directory", ENOTDIR: "Not a directory",
    EEXIST: "File exists", ENOTEMPTY: "Directory not empty", EACCES: "Permission denied", EBUSY: "Device or resource busy" };
  SIM.MSG = MSG;
  const chemin = (SIM.chemin = {
    norm(p, cwd = "/") {
      const abs = p.startsWith("/") ? p : cwd.replace(/\/$/, "") + "/" + p;
      const out = [];
      for (const s of abs.split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
      return "/" + out.join("/");
    },
    parent: (p) => p.slice(0, p.lastIndexOf("/")) || "/",
    base: (p) => p.slice(p.lastIndexOf("/") + 1),
  });

  // Système de fichiers en mémoire : chemin absolu -> nœud {type: "f"|"d", contenu, taille?, uid, gid, mode, mtime, special?}.
  class FSMemoire {
    constructor(proprio = { uid: 0, gid: 0 }) {
      this.n = new Map();
      this.proprio = proprio;
      this.n.set("/", { type: "d", uid: 0, gid: 0, mode: 0o755, mtime: H.now() });
    }
    stat(p) { return this.n.get(p) || null; }
    taille(node) { return node.type === "d" ? 4096 : node.taille !== undefined ? node.taille : O.octets(node.contenu || ""); }
    mkdir(p, o = {}) {
      if (p === "/") return o.parents ? null : "EEXIST";
      const ex = this.n.get(p);
      if (ex) return ex.type === "d" && o.parents ? null : "EEXIST";
      const par = chemin.parent(p);
      if (!this.n.get(par)) { if (!o.parents) return "ENOENT"; const e = this.mkdir(par, o); if (e) return e; }
      if (this.n.get(par).type !== "d") return "ENOTDIR";
      this.n.set(p, { type: "d", uid: o.uid ?? this.proprio.uid, gid: o.gid ?? this.proprio.gid, mode: o.mode ?? 0o755, mtime: H.now() });
      return null;
    }
    ecrire(p, contenu, o = {}) {
      const par = this.n.get(chemin.parent(p));
      if (!par) return "ENOENT";
      if (par.type !== "d") return "ENOTDIR";
      const ex = this.n.get(p);
      if (ex && ex.type === "d") return "EISDIR";
      const n = ex && o.ajout ? { ...ex, contenu: (ex.contenu || "") + contenu, taille: undefined } :
        { type: "f", contenu, uid: o.uid ?? (ex ? ex.uid : this.proprio.uid), gid: o.gid ?? (ex ? ex.gid : this.proprio.gid), mode: o.mode ?? (ex ? ex.mode : 0o644) };
      if (o.taille !== undefined) n.taille = o.taille;
      if (o.archive) n.archive = o.archive; else if (!o.ajout) delete n.archive;
      n.mtime = H.now();
      this.n.set(p, n);
      return null;
    }
    lire(p) {
      const n = this.n.get(p);
      if (!n) return { err: "ENOENT" };
      if (n.type === "d") return { err: "EISDIR" };
      return { node: n, contenu: n.contenu || "" };
    }
    lister(p) {
      const n = this.n.get(p);
      if (!n) return { err: "ENOENT" };
      if (n.type !== "d") return { noms: [chemin.base(p)], fichier: true };
      const pre = p === "/" ? "/" : p + "/";
      const noms = [];
      for (const k of this.n.keys()) if (k !== p && k.startsWith(pre) && !k.slice(pre.length).includes("/")) noms.push(k.slice(pre.length));
      return { noms: noms.sort() };
    }
    rm(p, o = {}) {
      const n = this.n.get(p);
      if (!n) return "ENOENT";
      if (n.type === "d") {
        if (!o.recursif && !o.dossier) return "EISDIR";
        const enfants = [...this.n.keys()].filter((k) => k.startsWith(p + "/"));
        if (!o.recursif && enfants.length) return "ENOTEMPTY";
        enfants.forEach((k) => this.n.delete(k));
      }
      this.n.delete(p);
      return null;
    }
    // Liste récursive (pour build, tar, du) : [{p, node}] sous p.
    parcourir(p) {
      const n = this.n.get(p);
      if (!n) return [];
      if (n.type !== "d") return [{ p, node: n }];
      const pre = p === "/" ? "/" : p + "/";
      return [...this.n.entries()].filter(([k]) => k.startsWith(pre)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => ({ p: k, node: v }));
    }
  }
  SIM.FSMemoire = FSMemoire;

  /* --------------------------------------------- lexer et analyseur shell */
  const OPS = ["2>&1", "&>>", "&>", "2>>", ">>", "<<-", "<<", "&&", "||", "2>", "1>", ">&2", ">", "<", "|", ";", "&"];

  function lexer(src) {
    const toks = []; const enAttente = [];
    let i = 0; let mot = null; let incomplet = false;
    const ajout = (q, t) => { if (!mot) mot = { type: "mot", parts: [] }; const d = mot.parts[mot.parts.length - 1]; if (d && d.q === q) d.t += t; else mot.parts.push({ q, t }); };
    const finir = () => { if (mot) { toks.push(mot); mot = null; } };
    const balance = (j) => {
      // src[j] === "(" après "$" : renvoie l'index après la parenthèse fermante.
      let prof = 0; let q = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (q) { if (c === q) q = null; else if (c === "\\" && q === '"') j++; continue; }
        if (c === "'" || c === '"') q = c;
        else if (c === "(") prof++;
        else if (c === ")") { prof--; if (prof === 0) return j + 1; }
      }
      incomplet = true; return src.length;
    };
    while (i < src.length) {
      const c = src[i];
      if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
      if (c === "\n") {
        finir(); toks.push({ type: "op", v: "\n" }); i++;
        // Corps des heredocs en attente : lignes jusqu'au délimiteur.
        while (enAttente.length) {
          const h = enAttente.shift(); const corps = [];
          let trouve = false;
          while (i < src.length || (i === src.length && false)) {
            let fin = src.indexOf("\n", i); if (fin < 0) fin = src.length;
            let ligne = src.slice(i, fin); i = Math.min(fin + 1, src.length + 1);
            if (h.strip) ligne = ligne.replace(/^\t+/, "");
            if (ligne === h.delim) { trouve = true; break; }
            corps.push(ligne);
            if (fin >= src.length) break;
          }
          if (!trouve) incomplet = true;
          h.corps = corps.length ? corps.join("\n") + "\n" : "";
        }
        continue;
      }
      if (c === " " || c === "\t") { finir(); i++; continue; }
      if (c === "#" && !mot) { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "'") {
        const f = src.indexOf("'", i + 1);
        if (f < 0) { incomplet = true; ajout("s", src.slice(i + 1)); i = src.length; continue; }
        ajout("s", src.slice(i + 1, f)); i = f + 1; continue;
      }
      if (c === '"') {
        let j = i + 1; let t = "";
        while (j < src.length && src[j] !== '"') {
          if (src[j] === "\\" && j + 1 < src.length) {
            const s = src[j + 1];
            if ('"\\$`'.includes(s)) { t += s === "$" ? "\\$" : s; j += 2; continue; }
            if (s === "\n") { j += 2; continue; }
            t += "\\"; j++; continue;
          }
          if (src[j] === "$" && src[j + 1] === "(") { const f = balance(j + 1); t += src.slice(j, f); j = f; continue; }
          t += src[j]; j++;
        }
        if (j >= src.length) incomplet = true;
        ajout("d", t); i = j + 1; continue;
      }
      if (c === "\\") { ajout("s", src[i + 1] || ""); i += 2; continue; }
      if (c === "$" && src[i + 1] === "(") { const f = balance(i + 1); ajout("n", src.slice(i, f)); i = f; continue; }
      if (c === "$" && src[i + 1] === "{") { const f = src.indexOf("}", i); const fin = f < 0 ? src.length : f + 1; ajout("n", src.slice(i, fin)); i = fin; continue; }
      const op = OPS.find((o) => src.startsWith(o, i) && (!/^[12]/.test(o) || !mot));
      if (op) {
        finir(); i += op.length;
        if (op === "<<" || op === "<<-") {
          while (src[i] === " ") i++;
          let d = ""; let quote = false;
          while (i < src.length && !/[\s;&|<>]/.test(src[i])) { if (src[i] === "'" || src[i] === '"') quote = true; else d += src[i]; i++; }
          const h = { type: "heredoc", delim: d, strip: op === "<<-", expansion: !quote, corps: null };
          toks.push(h); enAttente.push(h);
        } else toks.push({ type: "op", v: op });
        continue;
      }
      ajout("n", c); i++;
    }
    finir();
    if (enAttente.length) incomplet = true;
    return { toks, incomplet };
  }

  const motLitteral = (t) => t && t.type === "mot" && t.parts.length === 1 && t.parts[0].q === "n" ? t.parts[0].t : null;

  function analyser(toks) {
    let i = 0;
    const SEP = new Set([";", "\n", "&", "&&", "||"]);
    function liste(arrets) {
      const items = []; let op = null;
      while (i < toks.length) {
        const t = toks[i];
        if (t.type === "op" && (t.v === "\n" || t.v === ";")) { i++; continue; }
        if (arrets && arrets.includes(motLitteral(t))) break;
        const p = pipeline();
        if (!p.length) { i++; continue; }
        let sep = ";";
        if (i < toks.length && toks[i].type === "op" && SEP.has(toks[i].v)) { sep = toks[i].v; i++; }
        items.push({ op, pipe: p, fond: sep === "&" });
        op = sep === "&&" || sep === "||" ? sep : null;
      }
      return items;
    }
    function pipeline() {
      const cmds = [commande()];
      while (i < toks.length && toks[i].type === "op" && toks[i].v === "|") { i++; cmds.push(commande()); }
      return cmds.filter(Boolean);
    }
    function commande() {
      const t = toks[i];
      if (motLitteral(t) === "for") {
        i++;
        const variable = motLitteral(toks[i]); i++;
        const mots = [];
        if (motLitteral(toks[i]) === "in") { i++; while (i < toks.length && toks[i].type === "mot") mots.push(toks[i++]); }
        while (i < toks.length && toks[i].type === "op" && (toks[i].v === ";" || toks[i].v === "\n")) i++;
        if (motLitteral(toks[i]) === "do") i++;
        const corps = liste(["done"]);
        if (motLitteral(toks[i]) === "done") i++;
        return { type: "for", variable, mots, corps, redirs: [] };
      }
      const c = { type: "simple", affect: [], mots: [], redirs: [], time: false };
      while (i < toks.length) {
        const k = toks[i];
        if (k.type === "op") {
          if ([">", ">>", "1>", "2>", "2>>", "<", "&>", "&>>"].includes(k.v)) { c.redirs.push({ op: k.v, cible: toks[i + 1] }); i += 2; continue; }
          if (k.v === "2>&1" || k.v === ">&2") { c.redirs.push({ op: k.v }); i++; continue; }
          break;
        }
        if (k.type === "heredoc") { c.redirs.push({ op: "<<", heredoc: k }); i++; continue; }
        const lit = motLitteral(k);
        if (!c.mots.length && lit === "time" && !c.time) { c.time = true; i++; continue; }
        if (!c.mots.length && k.parts[0].q === "n" && /^[A-Za-z_]\w*=/.test(k.parts[0].t)) { c.affect.push(k); i++; continue; }
        c.mots.push(k); i++;
      }
      return c.mots.length || c.affect.length || c.redirs.length ? c : null;
    }
    return liste(null);
  }
  SIM.lexer = lexer;

  /* ------------------------------------------------------ interpréteur */
  // Variantes : "bash" (hôte, GNU), "sh" (busybox : alpine, busybox), "dash" (debian : nginx, httpd).
  class Shell {
    constructor(o) {
      this.fs = o.fs; this.cwd = o.cwd || "/"; this.env = Object.assign({}, o.env || {});
      this.variante = o.variante || "bash"; this.commandes = o.commandes || {}; this.ctx = o.ctx || {};
      this.uid = o.uid || 0; this.jobs = o.jobs || []; this.code = 0; this.nomShell = o.nomShell || (this.variante === "bash" ? "bash" : "sh");
      this.vars = {};
    }
    sous() {
      const s = new Shell({ fs: this.fs, cwd: this.cwd, env: this.env, variante: this.variante, commandes: this.commandes, ctx: this.ctx, uid: this.uid, jobs: this.jobs });
      s.vars = Object.assign({}, this.vars); s.code = this.code; return s;
    }
    variable(n) {
      if (n === "?") return String(this.code);
      if (n === "$") return String(this.ctx.pid || 4242);
      if (n === "PWD") return this.cwd;
      if (n in this.vars) return this.vars[n];
      return this.env[n] !== undefined ? this.env[n] : "";
    }
    // Expansion d'un texte : $VAR, ${VAR}, ${VAR:-x}, $(cmd). Renvoie des morceaux {t, decoupable}.
    developper(t, decoupable) {
      const out = []; let cur = ""; let j = 0;
      const pousser = (v, d) => { if (cur) { out.push({ t: cur, d: false }); cur = ""; } out.push({ t: v, d }); };
      while (j < t.length) {
        const c = t[j];
        if (c === "\\" && t[j + 1] === "$") { cur += "$"; j += 2; continue; }
        if (c === "$" && t[j + 1] === "(") {
          let prof = 0; let k = j + 1;
          for (; k < t.length; k++) { if (t[k] === "(") prof++; else if (t[k] === ")") { prof--; if (!prof) break; } }
          const r = this.sous().executer(t.slice(j + 2, k), { capture: true });
          this.erreursSubst.push(...r.l.filter((x) => x.e || x.pause));
          pousser(R.textes(r.l).join("\n").replace(/\n+$/, ""), decoupable); j = k + 1; continue;
        }
        if (c === "$" && t[j + 1] === "{") {
          const k = t.indexOf("}", j); const corps = t.slice(j + 2, k);
          const m = /^(\w+)(?::?-(.*))?$/.exec(corps);
          let v = m ? this.variable(m[1]) : "";
          if (m && m[2] !== undefined && !v) v = m[2];
          pousser(v, decoupable); j = k + 1; continue;
        }
        if (c === "$" && /[\w?$]/.test(t[j + 1] || "")) {
          const m = /^(\?|\$|[A-Za-z_]\w*|\d)/.exec(t.slice(j + 1));
          pousser(this.variable(m[1]), decoupable); j += 1 + m[1].length; continue;
        }
        cur += c; j++;
      }
      if (cur) out.push({ t: cur, d: false });
      return out;
    }
    // Mot du lexer -> liste de champs (découpage et globbing pour les parties non protégées).
    champs(mot) {
      let champs = [""]; let glob = false; let vide = true;
      mot.parts.forEach((p, idx) => {
        if (p.q === "s") { champs[champs.length - 1] += p.t; vide = false; return; }
        let t = p.t;
        if (p.q === "n" && idx === 0 && (t === "~" || t.startsWith("~/"))) t = (this.env.HOME || "/root") + t.slice(1);
        if (p.q === "n" && /[*?[]/.test(t.replace(/\$\([^)]*\)/g, ""))) glob = true;
        for (const m of this.developper(t, p.q === "n")) {
          if (m.d) {
            const bouts = m.t.split(/\s+/);
            if (m.t.trim() === "") { continue; }
            if (/^\s/.test(m.t)) champs.push("");
            bouts.filter((b, k) => b !== "" || (k > 0 && k < bouts.length - 1)).forEach((b, k) => { if (k) champs.push(""); champs[champs.length - 1] += b; });
            if (/\s$/.test(m.t)) champs.push("");
            vide = false;
          } else { champs[champs.length - 1] += m.t; if (p.q !== "n" || m.t) vide = false; }
        }
        if (p.q !== "n") vide = false;
      });
      champs = champs.filter((c, k) => c !== "" || (!vide && champs.length === 1 && k === 0));
      if (glob) champs = champs.flatMap((c) => this.glob(c));
      return champs;
    }
    glob(motif) {
      if (!/[*?[]/.test(motif)) return [motif];
      const abs = motif.startsWith("/");
      const segs = motif.split("/").filter((s, k) => s !== "" || k === 0);
      let cand = [abs ? "/" : ""];
      for (const s of segs) {
        if (s === "") continue;
        const suiv = [];
        for (const base of cand) {
          const dossier = chemin.norm(base || ".", this.cwd);
          if (!/[*?[]/.test(s)) { suiv.push(base ? (base.endsWith("/") ? base + s : base + "/" + s) : s); continue; }
          const re = new RegExp("^" + s.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
          const l = this.fs.lister(dossier);
          (l.noms || []).filter((n) => re.test(n) && (!n.startsWith(".") || s.startsWith("."))).forEach((n) => suiv.push(base ? (base.endsWith("/") ? base + n : base + "/" + n) : n));
        }
        cand = suiv.filter((c) => this.fs.stat(chemin.norm(c, this.cwd)));
      }
      return cand.length ? cand.sort() : [motif];
    }

    executer(src, o = {}) {
      this.erreursSubst = []; this.sortie = false;
      const { toks, incomplet } = lexer(src);
      if (incomplet && !o.capture) return { l: [{ t: `${this.nomShell}: syntax error: unexpected end of file`, e: true }], code: 2, incomplet: true };
      const items = analyser(toks);
      const l = [];
      for (const it of items) {
        if (it.op === "&&" && this.code !== 0) continue;
        if (it.op === "||" && this.code === 0) continue;
        const r = it.fond ? this.fond(it.pipe) : this.pipeline(it.pipe);
        l.push(...r.l);
        this.code = r.code;
        if (r.sortie) { this.sortie = true; break; }
      }
      l.unshift(...this.erreursSubst);
      return { l, code: this.code, sortie: this.sortie };
    }

    // cmd & : dans un conteneur, un processus de plus (soumis à --pids-limit) ; sur l'hôte, une tâche numérotée.
    fond(pipe) {
      const texte = pipe.map((c) => (c.mots || []).map((m) => m.parts.map((p) => p.t).join("")).join(" ")).join(" | ");
      if (SIM.lancerFond) { const r = SIM.lancerFond(this, pipe, texte); if (r) return r; }
      const n = this.jobs.length + 1; const pid = 4300 + Math.floor(Math.random() * 3000);
      const job = { n, pid, texte, actif: true, arreter: null };
      this.jobs.push(job);
      this.jobCourant = job;
      const r = this.pipeline(pipe);
      this.jobCourant = null;
      return { l: [{ t: `[${n}] ${pid}` }].concat(r.l), code: 0 };
    }

    pipeline(cmds) {
      let entree = null; const l = []; let code = 0; let sortie = false;
      cmds.forEach((c, k) => {
        const dernier = k === cmds.length - 1;
        const r = c.type === "for" ? this.boucle(c, entree) : this.simple(c, entree, dernier);
        code = r.code; if (r.sortie) sortie = true;
        if (dernier) l.push(...r.l);
        else { l.push(...r.l.filter((x) => x.e || x.pause)); entree = R.textes(r.l); }
      });
      return { l, code, sortie };
    }

    boucle(c, entree) {
      const vals = c.mots.flatMap((m) => this.champs(m));
      const l = []; let code = 0;
      for (const v of vals) {
        this.vars[c.variable] = v;
        for (const it of c.corps) {
          if (it.op === "&&" && code !== 0) continue;
          if (it.op === "||" && code === 0) continue;
          const r = it.fond ? this.fond(it.pipe) : this.pipeline(it.pipe);
          l.push(...r.l); code = r.code; this.code = code;
          if (r.sortie) return { l, code, sortie: true };
        }
      }
      return { l, code };
    }

    messageRedir(cible, err) {
      if (this.variante === "sh") return `sh: can't create ${cible}: ${MSG[err]}`;
      if (this.variante === "dash") return `sh: 1: cannot create ${cible}: ${MSG[err]}`;
      return `bash: ${cible}: ${MSG[err]}`;
    }

    simple(c, entree, dernier = true) {
      SIM.tic();
      const t0 = H.now();
      const env = {};
      for (const a of c.affect) {
        const brut = a.parts.map((p) => p.t).join("");
        const nom = brut.slice(0, brut.indexOf("="));
        const val = this.champs({ parts: [{ q: a.parts[0].q, t: a.parts[0].t.slice(nom.length + 1) }, ...a.parts.slice(1)] }).join(" ");
        env[nom] = val;
      }
      const args = c.mots.flatMap((m) => this.champs(m));
      if (!args.length) { Object.assign(this.vars, env); return R.ok(); }
      // Redirections : ouvertes avant l'exécution, comme un vrai shell.
      let fd1 = "term"; let fd2 = "term"; let stdin = entree;
      for (const r of c.redirs) {
        if (r.op === "<<") { stdin = (r.heredoc.expansion ? this.developper(r.heredoc.corps, false).map((m) => m.t).join("") : r.heredoc.corps).replace(/\n$/, "").split("\n"); if (r.heredoc.corps === "") stdin = []; continue; }
        if (r.op === "2>&1") { fd2 = fd1 === "term" ? "fusion" : fd1; continue; }
        if (r.op === ">&2") { fd1 = "err"; continue; }
        const cible = this.champs(r.cible)[0] || "";
        if (cible === "/dev/null") { if (r.op === "2>" || r.op === "2>>") fd2 = "null"; else if (r.op === "&>" || r.op === "&>>") { fd1 = "null"; fd2 = "null"; } else if (r.op !== "<") fd1 = "null"; continue; }
        const p = chemin.norm(cible, this.cwd);
        if (r.op === "<") {
          const f = this.fs.lire(p);
          if (f.err) return R.err(`${this.nomShell}: ${cible}: ${MSG[f.err]}`, 1);
          stdin = f.contenu.replace(/\n$/, "").split("\n");
          continue;
        }
        const ajout = r.op.endsWith(">>");
        const e = this.fs.ecrire(p, "", { ajout: true, uid: this.uid, gid: this.uid });
        if (e) return R.err(this.messageRedir(cible, e), this.variante === "dash" ? 2 : 1);
        if (!ajout) this.fs.ecrire(p, "", { uid: this.uid, gid: this.uid });
        const tgt = { fichier: p };
        if (r.op === "2>" || r.op === "2>>") fd2 = tgt;
        else if (r.op === "&>" || r.op === "&>>") { fd1 = tgt; fd2 = tgt; }
        else fd1 = tgt;
      }
      const res = this.lancer(args, stdin, env, { tty: dernier && fd1 === "term" && this.tty });
      // Répartition des sorties.
      const l = [];
      const ecrireF = (tgt, t) => { this.fs.ecrire(tgt.fichier, t + "\n", { ajout: true }); };
      for (const x of res.l) {
        if (x.pause !== undefined || x.t === undefined) { l.push(x); continue; }
        if (x.brut !== undefined && !x.e && fd1 !== "term" && fd1 !== "null" && fd1 !== "err") { this.fs.ecrire(fd1.fichier, x.brut, { ajout: true, taille: x.taille }); continue; }
        let tgt = x.e ? fd2 : fd1;
        if (tgt === "fusion") { l.push({ t: x.t }); continue; }
        if (tgt === "err") { l.push({ t: x.t, e: true }); continue; }
        if (tgt === "null") continue;
        if (tgt === "term") { l.push(x); continue; }
        ecrireF(tgt, x.t);
      }
      if (res.archive && fd1 !== "term" && fd1 !== "null") { const n = this.fs.stat(fd1.fichier); if (n) { n.archive = res.archive; n.taille = res.taille; } }
      if (c.time) {
        const ms = Math.max(H.now() - t0, 0) + O.entre(5, 40);
        const f = (v) => `${Math.floor(v / 60000)}m${((v % 60000) / 1000).toFixed(3)}s`;
        l.push({ t: "", e: true }, { t: `real\t${f(ms)}`, e: true }, { t: `user\t${f(O.entre(5, 40))}`, e: true }, { t: `sys\t${f(O.entre(10, 35))}`, e: true });
      }
      return { l, code: res.code, sortie: res.sortie };
    }

    // Lance une commande déjà découpée (aussi utilisé par docker exec).
    lancer(args, stdin, env = {}, o = {}) {
      const [nom, ...a] = args;
      const ctx = { sh: this, args: a, stdin, env: Object.assign({}, this.env, env), fs: this.fs, cwd: this.cwd, nom, variante: this.variante, uid: this.uid, tty: !!o.tty, ...this.ctx };
      const b = BUILTINS[nom];
      if (b) return b(ctx);
      const f = this.commandes[nom];
      if (f) {
        const r = f(ctx);
        return r || R.ok();
      }
      if (this.variante === "bash") return R.err(`${nom}: command not found`, 127);
      if (this.variante === "dash") return R.err(`sh: 1: ${nom}: not found`, 127);
      return R.err(`sh: ${nom}: not found`, 127);
    }
  }
  SIM.Shell = Shell;

  /* ------------------------------------------------------- commandes intégrées */
  const BUILTINS = {
    cd(x) {
      const cible = x.args[0] === undefined || x.args[0] === "~" ? x.sh.env.HOME || "/" : x.args[0] === "-" ? x.sh.ancien || x.sh.cwd : x.args[0];
      const p = chemin.norm(cible, x.sh.cwd);
      const n = x.fs.stat(p);
      if (!n) return R.err(x.variante === "bash" ? `bash: cd: ${x.args[0]}: No such file or directory` : `sh: cd: can't cd to ${x.args[0]}: No such file or directory`, x.variante === "dash" ? 2 : 1);
      if (n.type !== "d") return R.err(`bash: cd: ${x.args[0]}: Not a directory`, 1);
      x.sh.ancien = x.sh.cwd; x.sh.cwd = p; x.sh.env.PWD = p;
      return R.ok();
    },
    export(x) { x.args.forEach((a) => { const k = a.indexOf("="); if (k > 0) x.sh.env[a.slice(0, k)] = a.slice(k + 1); else if (x.sh.vars[a] !== undefined) x.sh.env[a] = x.sh.vars[a]; }); return R.ok(); },
    unset(x) { x.args.forEach((a) => { delete x.sh.env[a]; delete x.sh.vars[a]; }); return R.ok(); },
    exit(x) { const r = R.ok([], parseInt(x.args[0] || "0", 10) || 0); r.sortie = true; return r; },
    true: () => R.ok(),
    false: () => R.ok([], 1),
    ":": () => R.ok(),
    jobs(x) { return R.ok(x.sh.jobs.filter((j) => j.actif).map((j) => `[${j.n}]+  Running                 ${j.texte} &`)); },
    kill(x) {
      const l = [];
      for (const a of x.args.filter((v) => !/^-/.test(v))) {
        if (a.startsWith("%")) {
          const j = x.sh.jobs.find((v) => v.n === parseInt(a.slice(1), 10) && v.actif);
          if (!j) return R.err(`bash: kill: ${a}: no such job`, 1);
          j.actif = false; if (j.arreter) j.arreter();
          l.push({ t: `[${j.n}]+  Terminated              ${j.texte}` });
        } else {
          const ok = SIM.tuerPid ? SIM.tuerPid(parseInt(a, 10)) : false;
          if (!ok) return R.err(`bash: kill: (${a}) - No such process`, 1);
        }
      }
      return R.ok(l);
    },
    echo(x) {
      let a = x.args.slice(); let nl = true; let e = false;
      while (a[0] && /^-[neE]+$/.test(a[0])) { if (a[0].includes("n")) nl = false; if (a[0].includes("e")) e = true; a.shift(); }
      let t = a.join(" ");
      if (e || x.variante === "dash") t = echapper(t);
      return nl ? R.ok(t.split("\n")) : R.ok([{ t, brut: t }]);
    },
    printf(x) {
      const [fmt, ...vals] = x.args;
      if (fmt === undefined) return R.err("printf: usage: printf [-v var] format [arguments]", 2);
      let k = 0;
      const t = echapper(fmt).replace(/%(-?\d*)([sdq%])/g, (_, w, c) => {
        if (c === "%") return "%";
        const v = vals[k++] ?? "";
        return w ? (w.startsWith("-") ? O.pad(v, +w.slice(1)) : O.padG(v, +w)) : String(v);
      });
      const lignes = t.split("\n");
      const finNl = t.endsWith("\n");
      if (finNl) lignes.pop();
      const l = lignes.map((v) => ({ t: v }));
      if (!finNl && l.length) l[l.length - 1].brut = lignes[lignes.length - 1];
      // contenu exact pour les redirections : on garde les sauts de ligne voulus
      return { l, code: 0 };
    },
    pwd: (x) => R.ok(x.sh.cwd),
    sleep(x) {
      const v = x.args[0] || "0";
      if (v === "infinity") return R.ok([{ pause: 600000 }]);
      const ms = Math.round(parseFloat(v) * ({ s: 1, m: 60, h: 3600 }[v.slice(-1)] || 1) * 1000);
      if (isNaN(ms)) return R.err(`sleep: invalid time interval '${v}'`, 1);
      H.avancer(ms);
      return R.ok([{ pause: ms }]);
    },
    test: (x) => tester(x, x.args),
    "[": (x) => tester(x, x.args.slice(0, -1)),
    type(x) { return R.ok(x.args.map((a) => (BUILTINS[a] ? `${a} is a shell builtin` : x.sh.commandes[a] ? `${a} is /usr/bin/${a}` : `bash: type: ${a}: not found`))); },
  };
  BUILTINS.which = (x) => { const l = x.args.filter((a) => x.sh.commandes[a] || BUILTINS[a]); return R.ok(l.map((a) => (a === "docker" ? "/usr/bin/docker" : a === "kubectl" || a === "minikube" ? "/home/eleve/.local/bin/" + a : "/usr/bin/" + a)), l.length === x.args.length ? 0 : 1); };

  function echapper(t) {
    return t.replace(/\\(n|t|\\|0|a|r|e)/g, (_, c) => ({ n: "\n", t: "\t", "\\": "\\", 0: "", a: "", r: "\r", e: "\x1b" }[c]));
  }
  function tester(x, a) {
    const st = (p) => x.fs.stat(chemin.norm(p, x.sh.cwd));
    let ok = false;
    if (a[0] === "-f") ok = !!st(a[1]) && st(a[1]).type === "f";
    else if (a[0] === "-d") ok = !!st(a[1]) && st(a[1]).type === "d";
    else if (a[0] === "-e") ok = !!st(a[1]);
    else if (a[0] === "-z") ok = !a[1];
    else if (a[0] === "-n") ok = !!a[1];
    else if (a[1] === "=" || a[1] === "==") ok = a[0] === a[2];
    else if (a[1] === "!=") ok = a[0] !== a[2];
    else if (a.length === 1) ok = !!a[0];
    return R.ok([], ok ? 0 : 1);
  }
  SIM.BUILTINS = BUILTINS;

  /* ------------------------------------------------------- commandes Unix */
  // Chaque commande reçoit le contexte x : {args, stdin, fs, sh, variante, env, uid} et renvoie R.ok / R.err.
  const gnu = (x) => x.variante === "bash" || x.variante === "dash";
  const absolu = (x, p) => chemin.norm(p, x.sh.cwd);
  function options(args, avecValeur = []) {
    // Sépare options courtes groupées (-rf), longues (--x=y) et opérandes.
    const o = {}; const ops = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { ops.push(...args.slice(i + 1)); break; }
      if (a.startsWith("--")) { const [k, v] = a.slice(2).split(/=(.*)/s); o[k] = v !== undefined ? v : avecValeur.includes(k) ? args[++i] : true; continue; }
      if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (avecValeur.includes(c)) { o[c] = a.slice(j + 1) || args[++i]; break; }
          o[c] = true;
        }
        continue;
      }
      ops.push(a);
    }
    return { o, ops };
  }
  SIM.options = options;
  const lignesDe = (contenu) => (contenu === "" ? [] : contenu.replace(/\n$/, "").split("\n"));

  function lireEntrees(x, fichiers, nomCmd) {
    // Concatène les fichiers (ou l'entrée standard). Renvoie {lignes, erreurs}.
    if (!fichiers.length) return { lignes: x.stdin || [], erreurs: [] };
    const lignes = []; const erreurs = [];
    for (const f of fichiers) {
      if (f === "-") { lignes.push(...(x.stdin || [])); continue; }
      const r = x.fs.lire(absolu(x, f));
      if (r.err) { erreurs.push(gnu(x) ? `${nomCmd}: ${f}: ${MSG[r.err]}` : nomCmd === "cat" ? `cat: can't open '${f}': ${MSG[r.err]}` : `${nomCmd}: ${f}: ${MSG[r.err]}`); continue; }
      if (r.node.special === "urandom") continue;
      lignes.push(...lignesDe(r.contenu));
    }
    return { lignes, erreurs };
  }

  const UNIX = (SIM.UNIX = {
    cat(x) {
      const { ops } = options(x.args);
      const { lignes, erreurs } = lireEntrees(x, ops, "cat");
      return { l: lignes.map((t) => ({ t })).concat(erreurs.map((t) => ({ t, e: true }))), code: erreurs.length ? 1 : 0 };
    },
    ls(x) {
      const { o, ops } = options(x.args);
      const cibles = ops.length ? ops : ["."];
      const l = []; let code = 0;
      const long = o.l || o.n;
      const ligneLongue = (nom, n) => {
        const type = n.type === "d" ? "d" : "-";
        const m = n.mode ?? (n.type === "d" ? 0o755 : 0o644);
        const rwx = [6, 3, 0].map((s) => ["r", "w", "x"].map((c, k) => ((m >> (s + 2 - k)) & 1 ? c : "-")).join("")).join("");
        const u = o.n ? String(n.uid ?? 0) : nomUid(x, n.uid ?? 0);
        const g = o.n ? String(n.gid ?? 0) : nomUid(x, n.gid ?? 0);
        const t = x.fs.taille ? x.fs.taille(n) : O.octets(n.contenu || "");
        return gnu(x) ? `${type}${rwx} 1 ${u} ${g} ${t} ${O.date.ls(n.mtime || H.now())} ${nom}`
          : `${type}${rwx}    1 ${O.pad(u, 8)} ${O.pad(g, 8)} ${O.padG(t, 9)} ${O.date.ls(n.mtime || H.now())} ${nom}`;
      };
      for (const c of cibles) {
        const p = absolu(x, c);
        const r = x.fs.lister(p);
        if (r.err) { l.push({ t: gnu(x) ? `ls: cannot access '${c}': ${MSG[r.err]}` : `ls: ${c}: ${MSG[r.err]}`, e: true }); code = gnu(x) ? 2 : 1; continue; }
        let noms = r.noms.filter((n) => o.a || o.A || !n.startsWith("."));
        if (o.a) noms = [".", ".."].concat(noms);
        if (r.fichier) { l.push({ t: long ? ligneLongue(c, x.fs.stat(p)) : c }); continue; }
        if (cibles.length > 1) l.push({ t: `${c}:` });
        if (long) {
          l.push({ t: `total ${noms.length * 4}` });
          noms.forEach((nm) => { const n = x.fs.stat(p === "/" ? "/" + nm : p + "/" + nm) || { type: "d" }; l.push({ t: ligneLongue(nm, n) }); });
        } else if ((o.C || x.tty) && !o["1"]) l.push(...colonnes(noms).map((t) => ({ t })));
        else noms.forEach((nm) => l.push({ t: nm }));
      }
      return { l, code };
    },
    mkdir(x) {
      const { o, ops } = options(x.args);
      const l = []; let code = 0;
      for (const d of ops) {
        const e = x.fs.mkdir(absolu(x, d), { parents: o.p || o.parents, uid: x.uid, gid: x.uid });
        if (e) { l.push({ t: gnu(x) ? `mkdir: cannot create directory '${d}': ${MSG[e]}` : `mkdir: can't create directory '${d}': ${MSG[e]}`, e: true }); code = 1; }
      }
      return { l, code };
    },
    rmdir(x) { const l = []; for (const d of x.args) { const e = x.fs.rm(absolu(x, d), { dossier: true }); if (e) l.push({ t: `rmdir: failed to remove '${d}': ${MSG[e]}`, e: true }); } return { l, code: l.length ? 1 : 0 }; },
    rm(x) {
      const { o, ops } = options(x.args);
      const l = []; let code = 0;
      for (const f of ops) {
        const e = x.fs.rm(absolu(x, f), { recursif: o.r || o.R || o.recursive });
        if (e && !(e === "ENOENT" && o.f)) {
          const m = e === "EISDIR" ? "Is a directory" : MSG[e];
          l.push({ t: gnu(x) ? `rm: cannot remove '${f}': ${m}` : `rm: can't remove '${f}': ${m}`, e: true }); code = 1;
        }
      }
      return { l, code };
    },
    touch(x) {
      const l = []; let code = 0;
      for (const f of options(x.args).ops) {
        const p = absolu(x, f);
        const n = x.fs.stat(p);
        const e = n ? x.fs.ecrire(p, "", { ajout: true }) : x.fs.ecrire(p, "", { uid: x.uid, gid: x.uid });
        if (e) { l.push({ t: gnu(x) ? `touch: cannot touch '${f}': ${MSG[e]}` : `touch: ${f}: ${MSG[e]}`, e: true }); code = 1; }
      }
      return { l, code };
    },
    cp(x) {
      const { o, ops } = options(x.args);
      const dest = ops.pop();
      for (const s of ops) {
        const ps = absolu(x, s); let pd = absolu(x, dest);
        const nd = x.fs.stat(pd);
        if (nd && nd.type === "d") pd = pd + "/" + chemin.base(ps);
        const n = x.fs.stat(ps);
        if (!n) return R.err(`cp: cannot stat '${s}': No such file or directory`, 1);
        if (n.type === "d") {
          if (!o.r && !o.R && !o.a) return R.err(`cp: -r not specified; omitting directory '${s}'`, 1);
          x.fs.mkdir(pd, { parents: true });
          x.fs.parcourir(ps).forEach(({ p, node }) => { const q = pd + p.slice(ps.length); if (node.type === "d") x.fs.mkdir(q, { parents: true }); else x.fs.ecrire(q, node.contenu, { taille: node.taille }); });
        } else {
          const e = x.fs.ecrire(pd, n.contenu, { taille: n.taille, archive: n.archive });
          if (e) return R.err(`cp: cannot create regular file '${dest}': ${MSG[e]}`, 1);
        }
      }
      return R.ok();
    },
    mv(x) {
      const r = UNIX.cp({ ...x, args: ["-r", ...x.args] });
      if (r.code) return r;
      x.args.slice(0, -1).forEach((s) => x.fs.rm(absolu(x, s), { recursif: true }));
      return R.ok();
    },
    chmod(x) {
      const [mode, ...fs] = options(x.args).ops;
      for (const f of fs) {
        const n = x.fs.stat(absolu(x, f));
        if (!n) return R.err(`chmod: cannot access '${f}': No such file or directory`, 1);
        if (/^[0-7]{3,4}$/.test(mode)) n.mode = parseInt(mode, 8);
      }
      return R.ok();
    },
    chown: () => R.ok(),
    grep(x) {
      const { o, ops } = options(x.args, ["e", "m", "A", "B", "C", "max-count"]);
      let motif = o.e !== undefined ? o.e : ops.shift();
      if (motif === undefined) return R.err("Usage: grep [OPTION]... PATTERNS [FILE]...", 2);
      const etendu = o.E || o.P;
      // grep de base : \| et \( \) ont le sens étendu ; | et () sont littéraux.
      let src = etendu ? motif : motif.replace(/\\\|/g, "\u0001").replace(/\|/g, "\\|").replace(/\u0001/g, "|").replace(/\\([()])/g, "\u0002$1").replace(/(?<!\u0002)([()])/g, "\\$1").replace(/\u0002/g, "").replace(/\\\{/g, "{").replace(/\\\}/g, "}");
      if (o.F) src = motif.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      src = src.replace(/\[\[:(\w+):\]\]/g, (_, c) => ({ digit: "[0-9]", alpha: "[A-Za-z]", space: "\\s", alnum: "[A-Za-z0-9]", upper: "[A-Z]", lower: "[a-z]" }[c] || "."));
      let re;
      try { re = new RegExp(src, o.i ? "i" : ""); } catch (e) { return R.err(`grep: Invalid regular expression`, 2); }
      const { lignes, erreurs } = lireEntrees(x, ops, "grep");
      const plusieurs = ops.length > 1;
      const res = []; let nb = 0;
      const max = o.m !== undefined ? parseInt(o.m, 10) : o["max-count"] !== undefined ? parseInt(o["max-count"], 10) : Infinity;
      const apres = parseInt(o.A || o.C || "0", 10); const avant = parseInt(o.B || o.C || "0", 10);
      let dernierAffiche = -1; let reste = 0;
      lignes.forEach((ligne, k) => {
        if (nb >= max && reste <= 0) return;
        const m = re.test(ligne) !== !!o.v;
        if (m && nb < max) {
          nb++;
          if ((apres || avant) && dernierAffiche >= 0 && k - avant > dernierAffiche + 1) res.push("--");
          for (let b = Math.max(dernierAffiche + 1, k - avant); b < k; b++) res.push(lignes[b]);
          res.push((o.n ? `${k + 1}:` : "") + (o.o ? (ligne.match(re) || [""])[0] : ligne));
          dernierAffiche = k; reste = apres;
        } else if (reste > 0) { res.push(ligne); dernierAffiche = k; reste--; }
      });
      if (o.q) return R.ok([], nb ? 0 : 1);
      const l = o.c ? [String(nb)] : plusieurs ? res : res;
      return { l: l.map((t) => ({ t })).concat(erreurs.map((t) => ({ t, e: true }))), code: erreurs.length ? 2 : nb ? 0 : 1 };
    },
    head(x) {
      const { o, ops } = options(x.args.map((a) => (/^-\d+$/.test(a) ? "-n" + a.slice(1) : a)), ["n", "c"]);
      if (o.c !== undefined) {
        const n = O.lireTaille(o.c);
        const f = ops[0] ? x.fs.lire(absolu(x, ops[0])) : null;
        if (f && f.err) return R.err(`head: cannot open '${ops[0]}' for reading: ${MSG[f.err]}`, 1);
        if (f && f.node.special === "urandom") return R.ok([{ t: "▒▓░".repeat(8), brut: "", taille: n }]);
        const txt = f ? f.contenu : (x.stdin || []).join("\n");
        return R.ok([{ t: txt.slice(0, n), brut: txt.slice(0, n) }]);
      }
      const n = parseInt(o.n || "10", 10);
      const { lignes, erreurs } = lireEntrees(x, ops, "head");
      return { l: lignes.slice(0, n).map((t) => ({ t })).concat(erreurs.map((t) => ({ t, e: true }))), code: erreurs.length ? 1 : 0 };
    },
    tail(x) {
      const { o, ops } = options(x.args.map((a) => (/^-\d+$/.test(a) ? "-n" + a.slice(1) : a)), ["n"]);
      if (ops.includes("/dev/zero")) return SIM.queueZero ? SIM.queueZero(x) : R.ok();
      const n = String(o.n || "10");
      const { lignes } = lireEntrees(x, ops, "tail");
      return R.ok(n.startsWith("+") ? lignes.slice(parseInt(n.slice(1), 10) - 1) : lignes.slice(-parseInt(n, 10)));
    },
    wc(x) {
      const { o, ops } = options(x.args);
      if (ops.length) {
        const l = [];
        for (const f of ops) {
          const r = x.fs.lire(absolu(x, f));
          if (r.err) { l.push({ t: `wc: ${f}: ${MSG[r.err]}`, e: true }); continue; }
          const t = x.fs.taille ? x.fs.taille(r.node) : O.octets(r.contenu);
          const nl = lignesDe(r.contenu).length;
          l.push({ t: o.c ? `${t} ${f}` : o.l ? `${nl} ${f}` : `${nl} ${r.contenu.split(/\s+/).filter(Boolean).length} ${t} ${f}` });
        }
        return { l, code: l.some((v) => v.e) ? 1 : 0 };
      }
      const lignes = x.stdin || [];
      if (o.c) return R.ok(String(O.octets(lignes.join("\n")) + (lignes.length ? 1 : 0)));
      if (o.w) return R.ok(String(lignes.join(" ").split(/\s+/).filter(Boolean).length));
      return R.ok(String(lignes.length));
    },
    sort(x) { const { o, ops } = options(x.args); const { lignes } = lireEntrees(x, ops, "sort"); let r = lignes.slice().sort(o.n ? (a, b) => parseFloat(a) - parseFloat(b) : undefined); if (o.r) r.reverse(); if (o.u) r = [...new Set(r)]; return R.ok(r); },
    uniq(x) { const { lignes } = lireEntrees(x, options(x.args).ops, "uniq"); return R.ok(lignes.filter((l, k) => l !== lignes[k - 1])); },
    tr(x) {
      const { o, ops } = options(x.args);
      const lignes = x.stdin || [];
      if (o.d) { const ens = ops[0]; return R.ok(lignes.map((l) => [...l].filter((c) => !ens.includes(c)).join(""))); }
      const [a, b] = ops.map((s) => s.replace(/\[:lower:\]/, "abcdefghijklmnopqrstuvwxyz").replace(/\[:upper:\]/, "ABCDEFGHIJKLMNOPQRSTUVWXYZ").replace(/\\n/g, "\n"));
      const txt = lignes.join("\n").replace(/./gs, (c) => { const k = a.indexOf(c); return k >= 0 ? b[Math.min(k, b.length - 1)] : c; });
      return R.ok(txt.split("\n"));
    },
    cut(x) {
      const { o, ops } = options(x.args, ["d", "f", "c"]);
      const { lignes } = lireEntrees(x, ops, "cut");
      const sel = (o.f || o.c || "1").split(",").flatMap((p) => { const [a, b] = p.split("-"); const d = parseInt(a || "1", 10); const f = b === undefined ? d : b === "" ? 999 : parseInt(b, 10); return Array.from({ length: f - d + 1 }, (_, k) => d + k - 1); });
      if (o.c) return R.ok(lignes.map((l) => sel.map((k) => l[k] || "").join("")));
      const d = o.d || "\t";
      return R.ok(lignes.map((l) => { const c = l.split(d); return c.length === 1 ? l : sel.filter((k) => k < c.length).map((k) => c[k]).join(d); }));
    },
    seq(x) { const n = x.args.map(Number); const [a, b] = n.length === 1 ? [1, n[0]] : n; return R.ok(Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => String(a + k))); },
    sed(x) {
      const { o, ops } = options(x.args, ["e"]);
      const expr = o.e !== undefined ? o.e : ops.shift();
      const appliquer = (lignes) => {
        const out = [];
        for (const l of lignes) {
          let m = /^s(.)(.*?)\1(.*?)\1([gI]*)$/.exec(expr);
          if (m) {
            const src = o.E || o.r ? m[2] : m[2].replace(/\\([()|{}+?])/g, "\u0001$1").replace(/([()|{}+?])/g, (c, _p, k, s) => (s[k - 1] === "\u0001" ? c : "\\" + c)).replace(/\u0001/g, "");
            out.push(l.replace(new RegExp(src, m[4].includes("g") ? "g" : ""), m[3].replace(/\\(\d)/g, "$$$1").replace(/&/g, "$$&")));
            continue;
          }
          m = /^\/(.*)\/d$/.exec(expr);
          if (m) { if (!new RegExp(m[1]).test(l)) out.push(l); continue; }
          m = /^(\d+)d$/.exec(expr);
          if (m) { if (out.length + 1 !== +m[1]) out.push(l); continue; }
          out.push(l);
        }
        return out;
      };
      if (o.i) {
        for (const f of ops) {
          const p = absolu(x, f); const r = x.fs.lire(p);
          if (r.err) return R.err(`sed: can't read ${f}: ${MSG[r.err]}`, 2);
          const e = x.fs.ecrire(p, appliquer(lignesDe(r.contenu)).join("\n") + "\n");
          if (e) return R.err(`sed: couldn't open temporary file ${f}: ${MSG[e]}`, 4);
        }
        return R.ok();
      }
      const { lignes, erreurs } = lireEntrees(x, ops, "sed");
      return { l: appliquer(lignes).map((t) => ({ t })).concat(erreurs.map((t) => ({ t: t.replace(/^sed: (.*): /, "sed: can't read $1: "), e: true }))), code: erreurs.length ? 2 : 0 };
    },
    awk(x) {
      // Le strict nécessaire : awk '{print $N}'.
      const prog = x.args[0] || ""; const m = /print\s+\$(\d+)/.exec(prog);
      const { lignes } = lireEntrees(x, x.args.slice(1), "awk");
      return R.ok(m ? lignes.map((l) => (l.trim().split(/\s+/)[+m[1] - 1] || "")) : lignes);
    },
    xargs(x) {
      const [cmd, ...a] = x.args;
      const vals = (x.stdin || []).join(" ").split(/\s+/).filter(Boolean);
      if (!vals.length && cmd === "docker") return x.sh.lancer([cmd, ...a], null);
      return x.sh.lancer([cmd, ...a, ...vals], null);
    },
    du(x) {
      const { o, ops } = options(x.args);
      const l = [];
      const blocs = (n) => (n.type === "d" ? 4096 : Math.ceil((x.fs.taille(n) || 1) / 4096) * 4096);
      for (const c of ops.length ? ops : ["."]) {
        const p = absolu(x, c); const n = x.fs.stat(p);
        if (!n) { l.push({ t: `du: cannot access '${c}': No such file or directory`, e: true }); continue; }
        const tot = x.fs.parcourir(p).reduce((s, e) => s + blocs(e.node), 0);
        l.push({ t: `${o.h ? O.tailleGnu(tot) : Math.ceil(tot / 1024)}\t${c}` });
      }
      return { l, code: l.some((v) => v.e) ? 1 : 0 };
    },
    base64(x) {
      const { o, ops } = options(x.args);
      const { lignes } = lireEntrees(x, ops, "base64");
      const txt = lignes.join("\n");
      try {
        if (o.d) { const b = atob(txt.replace(/\s/g, "")); const t = new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))); return R.ok([{ t, brut: t }]); }
        const t = btoa(String.fromCharCode(...new TextEncoder().encode(txt + "\n")));
        return R.ok(t);
      } catch (e) { return R.err("base64: invalid input", 1); }
    },
    date(x) {
      const f = x.args.find((a) => a.startsWith("+"));
      const t = H.now();
      if (f) return R.ok(f.slice(1).replace(/%T/g, O.date.hms(t)).replace(/%H/g, d2(new Date(t).getUTCHours())).replace(/%M/g, d2(new Date(t).getUTCMinutes())).replace(/%S/g, d2(new Date(t).getUTCSeconds())).replace(/%s/g, String(Math.floor(t / 1000))).replace(/%F/g, O.date.iso(t).slice(0, 10)));
      return R.ok(O.date.unix(t));
    },
    env(x) { return R.ok(Object.entries(x.env).filter(([k]) => k !== "PWD" || true).map(([k, v]) => `${k}=${v}`)); },
    printenv(x) { if (x.args[0]) return x.env[x.args[0]] !== undefined ? R.ok(x.env[x.args[0]]) : R.ok([], 1); return UNIX.env(x); },
    hostname(x) { return R.ok(x.env.HOSTNAME || "lab"); },
    uname(x) {
      const k = SIM.noyauVersion || "6.18.33.2-microsoft-standard-WSL2";
      if (x.args.includes("-r")) return R.ok(k);
      if (x.args.includes("-a")) return R.ok(`Linux ${x.env.HOSTNAME || "lab"} ${k} #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`);
      if (x.args.includes("-m")) return R.ok("x86_64");
      return R.ok("Linux");
    },
    id(x) { return SIM.idUtilisateur ? R.ok(SIM.idUtilisateur(x)) : R.ok("uid=0(root) gid=0(root) groups=0(root)"); },
    whoami(x) { const t = SIM.idUtilisateur ? SIM.idUtilisateur(x) : "uid=0(root)"; const m = /^uid=\d+\((\w+)\)/.exec(t); return m ? R.ok(m[1]) : R.err(`whoami: unknown uid ${x.uid}`, 1); },
    clear: () => R.ok([{ t: "\u0000clear" }]),
    nano(x) { return R.err(`(simulateur : pas d'éditeur plein écran ici. Pour écrire ${x.args[0] || "un fichier"}, colle un bloc « cat > ${x.args[0] || "fichier"} <<'EOF' … EOF ».)`, 1); },
    tar(x) {
      const { o, ops } = options(x.args, ["f", "C"]);
      const arch = o.f; const dest = o.C ? absolu(x, o.C) : x.sh.cwd;
      const f = arch ? x.fs.lire(absolu(x, arch)) : null;
      if (f && f.err) return R.err([`tar: ${arch}: Cannot open: ${MSG[f.err]}`, "tar: Error is not recoverable: exiting now"], 2);
      const entrees = f && f.node.archive;
      if (o.c) return R.ok();
      if (!entrees) return R.err(["tar: This does not look like a tar archive", "tar: Exiting with failure status due to previous errors"], 2);
      if (o.t) return R.ok(Object.keys(entrees));
      if (o.x && o.O) {
        const l = []; let manque = false;
        for (const p of ops) { if (entrees[p] === undefined || entrees[p] === null) { manque = true; l.push({ t: `tar: ${p}: Not found in archive`, e: true }); } else l.push(...lignesDe(typeof entrees[p] === "string" ? entrees[p] : "").map((t) => ({ t }))); }
        if (manque) l.push({ t: "tar: Exiting with failure status due to previous errors", e: true });
        return { l, code: manque ? 2 : 0 };
      }
      if (o.x) {
        for (const [p, v] of Object.entries(entrees)) {
          const q = chemin.norm(p, dest);
          if (p.endsWith("/")) { x.fs.mkdir(q, { parents: true }); continue; }
          x.fs.mkdir(chemin.parent(q), { parents: true });
          if (v && typeof v === "object") x.fs.ecrire(q, "", { archive: v.entrees, taille: v.taille });
          else x.fs.ecrire(q, v || "");
        }
        return R.ok();
      }
      return R.err("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options", 2);
    },
  });

  // Affichage en colonnes de ls dans un terminal de 80 caractères (remplissage par colonnes).
  function colonnes(noms) {
    if (!noms.length) return [];
    if (noms.join("  ").length <= 80) return [noms.join("  ")];
    for (let nl = 2; nl <= noms.length; nl++) {
      const nc = Math.ceil(noms.length / nl);
      const larg = Array.from({ length: nc }, (_, c) => Math.max(...noms.slice(c * nl, c * nl + nl).map((n) => n.length)));
      if (larg.reduce((s, v) => s + v + 2, 0) - 2 <= 80) {
        return Array.from({ length: nl }, (_, r) => Array.from({ length: nc }, (_, c) => noms[c * nl + r]).filter((v) => v !== undefined).map((v, c, arr) => (c === arr.length - 1 ? v : O.pad(v, larg[c] + 2))).join(""));
      }
    }
    return noms;
  }

  // Nom d'utilisateur ou numéro, d'après /etc/passwd du système de fichiers.
  function nomUid(x, uid) {
    const r = x.fs.lire("/etc/passwd");
    if (!r.err) for (const l of r.contenu.split("\n")) { const c = l.split(":"); if (c[2] === String(uid)) return c[0]; }
    return String(uid);
  }
  SIM.nomUid = nomUid;
})(typeof window !== "undefined" ? window : globalThis);
