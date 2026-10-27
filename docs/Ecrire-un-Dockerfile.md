# Écrire un Dockerfile

<p class="lead">Un Dockerfile est une <strong>recette</strong> : chaque ligne ajoute des fichiers ou fixe un réglage par défaut. <code>docker build</code> en tire une image ; le conteneur n'existe qu'au <code>docker run</code>.</p>

![Chaque ligne du Dockerfile part soit dans les couches, soit dans la configuration ; une image donne plusieurs conteneurs](assets/illustrations/img-dockerfile.png){ .hero }

## L'essentiel en 30 secondes

<div class="grid cards" markdown>

-   :material-hammer-wrench:{ .lg .middle } __build : la recette__

    ---

    Base, fichiers, commandes de préparation, réglages **par défaut**. Le résultat se publie sans jamais avoir tourné.

-   :material-play-circle-outline:{ .lg .middle } __run : l'exécution__

    ---

    Ports publiés, variables, montages, limites : décidés **au lancement**, sans reconstruire.

-   :material-layers-plus:{ .lg .middle } __Couche ou réglage__

    ---

    `RUN` et `COPY` écrivent des fichiers ; `ENV`, `USER`, `EXPOSE`, `CMD` remplissent la fiche de configuration.

-   :material-account-lock-outline:{ .lg .middle } __Non-root__

    ---

    Un utilisateur créé dans l'image, puis `USER` : le processus ne tourne plus en root.

</div>

!!! warning "À retenir"

    **`COPY` copie, il ne monte pas** : modifier le code ne change pas une image déjà construite. **`EXPOSE` documente, il n'ouvre rien** : on publie avec `-p` au lancement. **`RUN` agit une fois, au build**, jamais à chaque `docker run`.

## :material-file-document-edit-outline: Une première image

Le service : un petit serveur HTTP Python (bibliothèque standard seulement) qui écoute sur `0.0.0.0` et le port de la variable `PORT`. Écouter sur `127.0.0.1` le rendrait injoignable hors du conteneur.

???+ example "En vrai : le Dockerfile complet, construit puis lancé"

    ![Le Dockerfile, le build qui produit un identifiant, puis le conteneur qui répond](assets/captures/img_build.png)

    `COPY app.py .` cherche `app.py` dans le **contexte** (le dossier `atelier` passé à `docker build`) et le dépose dans le `WORKDIR`. Sur une base Debian, on créerait l'utilisateur avec `useradd --uid 10001 --create-home app`.

| Ligne | Pourquoi |
|---|---|
| `RUN adduser -D -u 10001 app` | un compte applicatif **dans l'image**, UID fixe et élevé |
| `COPY --chown=app:app app.py .` | fichier possédé par `app` sans `RUN chown` de plus ; **après** `adduser` |
| `ENV PYTHONUNBUFFERED=1` | journaux immédiats dans `docker logs` |
| `USER app` | le processus de démarrage ne tourne plus en root |

???+ example "En vrai : ce que l'image enregistre, ce que le lancement décide"

    ![La configuration de l'image, l'utilisateur réel du processus, et la différence entre EXPOSE et -p](assets/captures/img_config.png)

    `docker image inspect` lit le **modèle** ; `docker exec … id` interroge le **processus**. Sans `-p`, le port reste seulement documenté (`8080/tcp`) ; le publier sur `127.0.0.1` évite de l'ouvrir au réseau.

## :material-console-line: Qui lance quoi : `CMD` et `ENTRYPOINT`

| Dockerfile | `docker run img` | `docker run img python --version` |
|---|---|---|
| `CMD ["python", "app.py"]` | `python app.py` | `python --version` : la commande **remplace** `CMD` |
| `ENTRYPOINT ["python"]` + `CMD ["app.py"]` | `python app.py` | `python python --version` : les mots deviennent des **arguments** |

???+ example "En vrai : remplacer, compléter, forcer"

    ![Les quatre comportements de CMD et ENTRYPOINT au lancement](assets/captures/img_cmd.png)

    Avec un `ENTRYPOINT`, on tape `docker run img --version` ; pour changer l'exécutable lui-même : `--entrypoint`. Beaucoup d'images officielles combinent un script en `ENTRYPOINT` et le serveur en `CMD` (`php:8.4-apache` : `docker-php-entrypoint` + `apache2-foreground`).

!!! tip "Forme exec ou forme shell"

    `CMD ["python", "app.py"]` (exec, JSON) lance le programme **directement** : il reçoit `SIGTERM` à l'arrêt, mais `$PORT` n'est pas interprété. `CMD python app.py` (shell) passe par `/bin/sh -c` : les variables sont interprétées, mais c'est le shell qui reçoit les signaux. Préférez la forme exec.

## :material-variable: `ENV` ou `ARG` ?

| | `ENV` | `ARG` |
|---|---|---|
| Disponible pendant le build | oui | oui |
| Présente dans le conteneur | **oui** | non |
| Remplacée par | `docker run -e PORT=9090` | `docker build --build-arg APP_VERSION=1.1` |
| Pour un secret ? | **non** : visible dans `docker image inspect` | **non** : visible dans l'historique |

???+ example "En vrai : l'ARG sert au build, l'ENV reste dans le conteneur"

    ![La valeur d'ARG finit dans une étiquette mais pas dans l'environnement ; -e remplace une ENV](assets/captures/img_arg.png)

    Un `ARG` déclaré **avant** `FROM` ne sert qu'à paramétrer le `FROM` lui-même.

## :material-check-decagram-outline: Les bonnes pratiques

```dockerfile
FROM <base précise et maintenue>       # 1. 3.12-alpine, pas latest ; slim, alpine ou distroless si ça suffit
# 2. ce qui change rarement : paquets système, utilisateur
# 3. la liste des dépendances, puis leur installation
# 4. le code, qui change souvent
# 5. la configuration : ENV, USER, EXPOSE, HEALTHCHECK, CMD
```

Cet ordre sert le **cache** (voir [Contexte de build et cache](Contexte-de-build-et-cache.md)). À cela s'ajoutent : `COPY` plutôt que `ADD` (qui sait aussi extraire une archive ou télécharger), forme exec, utilisateur non-root, configuration externalisée (une même image en test et en production), données dans des **volumes**, **aucun secret** dans `ENV`, `ARG`, `COPY` ou le texte du Dockerfile ([Sécurité des images](Securite-des-images.md)).

???+ danger "Un composant manque : on corrige la recette, pas le conteneur"

    L'image `php:8.4-apache` n'a pas le pilote MariaDB : l'appli répond 503 (`could not find driver`). On ajoute `RUN docker-php-ext-install pdo_mysql` **avant** le `COPY` du code. Mais `docker compose restart web` ne change rien : il relance **le même conteneur sur la même image**. Il faut reconstruire **et** recréer : `docker compose up --build -d` (voir [Docker Compose](Docker-Compose.md)).

??? note "Les autres instructions"

    | Instruction | Rôle |
    |---|---|
    | `LABEL clé=valeur` | métadonnées (version, source, auteur) |
    | `VOLUME /data` | déclare un point de montage ; ne stocke **aucune** donnée dans l'image |
    | `HEALTHCHECK CMD …` | contrôle d'état périodique ; l'outil doit **exister dans l'image** (une image slim n'a pas forcément `curl`, mais Python peut faire la requête). Voir [Démarré n'est pas disponible](Demarre-n-est-pas-disponible.md). |

??? note "La même logique en Node.js"

    ```dockerfile
    FROM node:24-slim
    WORKDIR /app
    COPY package*.json ./
    RUN npm ci --omit=dev        # versions exactes du lock, sans dépendances de dev
    COPY . .
    EXPOSE 5000
    CMD ["npm", "start"]
    ```

    Dépendances d'abord, code ensuite. `COPY . .` copie **tout** le contexte : sans `.dockerignore`, un `node_modules` local, un `.git` ou un `.env` partent dans l'image.

## :material-flask-outline: À toi de jouer

??? note "Les deux fichiers à copier"

    `app.py` :

    ```python
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from os import getenv


    class App(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"Bonjour depuis Docker !\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


    HTTPServer(("0.0.0.0", int(getenv("PORT", "8080"))), App).serve_forever()
    ```

    `Dockerfile` :

    ```dockerfile
    FROM python:3.12-alpine
    WORKDIR /app
    RUN adduser -D -u 10001 app
    COPY --chown=app:app app.py .
    ENV PORT=8080
    ENV PYTHONUNBUFFERED=1
    USER app
    EXPOSE 8080
    CMD ["python", "app.py"]
    ```

```bash
mkdir atelier && cd atelier       # y créer app.py et le Dockerfile
docker build -t atelier:1.0 .
docker image history atelier:1.0 | head -10          # quelles lignes font 0 B ?
docker run -d --name w1 -p 127.0.0.1:8080:8080 atelier:1.0
curl http://127.0.0.1:8080
docker exec w1 id                                    # uid=10001(app)
docker run --rm -e PORT=9090 atelier:1.0 env | grep PORT
docker rm -f w1
```

Puis retirez `USER app`, reconstruisez et comparez `id`. Enfin, placez `RUN adduser` **après** `COPY --chown=app:app` : le build échoue, l'utilisateur n'existe pas encore.

??? abstract "Pour les créateurs : script de motion design (60 s)"

    Le Dockerfile en fiche de recette à gauche, l'image en bocal scellé au centre, les conteneurs en assiettes à droite.

    | Séq. | Durée | À l'écran | Animation | Texte à l'écran |
    |---|---|---|---|---|
    | 1 | 0-6 s | Une fiche « Dockerfile » vide | Les lignes s'écrivent une à une | « Un Dockerfile est une recette : une suite d'instructions. » |
    | 2 | 6-16 s | La ligne `FROM` s'allume ; un bocal se remplit d'un fond gris « Python » | Le fond se dépose | « FROM : on part d'une base existante. » |
    | 3 | 16-28 s | Les lignes `RUN` et `COPY` s'allument | Chacune ajoute une strate colorée dans le bocal | « RUN et COPY ajoutent des fichiers : une couche chacun. » |
    | 4 | 28-38 s | `ENV`, `USER`, `EXPOSE`, `CMD` s'allument | Elles s'inscrivent sur l'étiquette, pas dedans ; le bocal se scelle | « Les autres écrivent l'étiquette : la configuration par défaut. » |
    | 5 | 38-50 s | Deux assiettes servies depuis le bocal | L'une reçoit « -p 8080:8080 », l'autre « -e PORT=9090 -p 8090:9090 » | « docker run : une image, plusieurs conteneurs, chacun ses paramètres. » |
    | 6 | 50-60 s | On modifie `app.py` sur la fiche | Les assiettes ne changent pas ; un nouveau bocal apparaît | « Changer la recette ne change pas le bocal : on reconstruit, puis on remplace. » |

    La séquence 4 doit nettement trancher avec les séquences 2 et 3 : rien ne tombe dans le bocal.

??? info "Pour les créateurs : idées de schémas"

    - **Qui remplace quoi** : une boîte `CMD` que la commande tapée **pousse** hors de l'image ; une boîte `ENTRYPOINT` vissée, à laquelle la commande tapée vient **se coller** comme argument ; un tournevis `--entrypoint` seul capable de la dévisser.
    - **L'identité au fil du Dockerfile** : frise `FROM` (root), `RUN adduser` (root crée `app`), `COPY --chown` (fichier à `app`), `USER app` (bascule), `CMD` (processus en UID 10001). Une couronne au-dessus des étapes en root, un badge simple ensuite.
