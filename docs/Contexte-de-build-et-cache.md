# Contexte de build, cache et .dockerignore

<p class="lead">Le constructeur ne voit que les fichiers du <strong>contexte</strong>, filtré par <code>.dockerignore</code>, et il <strong>réutilise</strong> chaque étape tant que ses entrées n'ont pas changé. Bien filtrer et bien ordonner, c'est construire vite, petit et sans fuite.</p>

![À gauche, le .dockerignore filtre le contexte ; à droite, une modification de app.py ne rejoue que les étapes qui suivent](assets/illustrations/img-cache.png){ .hero }

## L'essentiel en 30 secondes

<div class="grid cards" markdown>

-   :material-folder-arrow-right-outline:{ .lg .middle } __Le contexte__

    ---

    Le dernier argument de `docker build`. `COPY` ne peut rien lire en dehors.

-   :material-filter-outline:{ .lg .middle } __.dockerignore__

    ---

    Exclut des fichiers **avant** l'envoi. Un fichier ignoré ne peut pas être copié.

-   :material-cached:{ .lg .middle } __Le cache__

    ---

    Entrées identiques : `CACHED`. Une étape invalidée **invalide toutes les suivantes**.

-   :material-layers-minus:{ .lg .middle } __Multi-étapes__

    ---

    On compile dans une étape, on ne livre que le résultat.

</div>

!!! warning "À retenir"

    **Le stable en haut, ce qui change souvent en bas.** Et un secret s'**exclut** du contexte : le supprimer dans une étape suivante ne l'efface pas de l'image.

## :material-folder-arrow-right-outline: Le contexte et son filtre

```bash
docker build -t web:1.0 .                      # le contexte : le dossier courant
docker build -f docker/Dockerfile -t web:1.0 . # Dockerfile ailleurs, contexte toujours « . »
```

`COPY ../config.ini .` est impossible : on ne sort pas du contexte. Le fichier `.dockerignore`, à la **racine du contexte**, retire des fichiers avant leur transfert :

| Motif | Exclut |
|---|---|
| `*.log` | les `.log` **à la racine seulement** |
| `**/*.log` | les `.log` à tous les niveaux |
| `secrets/` | le dossier `secrets` à la racine |
| `!important.log` | **réinclut** ce fichier malgré une règle précédente |

???+ example "En vrai : 50 Mo oubliés dans `public/`, trois `.dockerignore`"

    ![Le contexte transféré : 52 Mo sans filtre, encore 52 Mo avec *.tmp, 86 octets avec **/*.tmp](assets/captures/img_contexte.png)

    La première petite ligne (`2B`, `46B`, `55B`) est le transfert du `.dockerignore` lui-même ; la seconde, celui du contexte. Le motif `*.tmp` ne voit pas `public/gros.tmp`.

???+ example "En vrai : ce qui compte, c'est ce qui est DANS l'image"

    ![L'archive est présente dans l'image avec le motif racine, absente avec le motif récursif ; 112 Mo contre 6,8 Mo](assets/captures/img_dockerignore.png)

??? note "Un petit transfert ne prouve rien"

    BuildKit garde une copie des contextes déjà reçus et n'envoie que les **différences** : un `transferring context: 100B` peut cacher un gros fichier déjà transmis lors d'un build précédent. On vérifie donc toujours le **contenu de l'image** (`docker run --rm image ls -lh /chemin`). Sur son propre poste, on peut repartir d'une base propre en vidant ce seul cache : `docker builder prune -f --filter type=source.local`.

`.dockerignore` et `.gitignore` n'ont pas le même rôle : l'un filtre ce que reçoit le constructeur, l'autre ce que Git suit.

## :material-cached: Le cache, étape par étape

| Instruction | Clé de cache |
|---|---|
| `FROM` | l'image de base désignée (son digest) |
| `RUN` | l'étape précédente + le **texte** de la commande (pas ce qu'elle télécharge) |
| `COPY`, `ADD` | l'étape précédente + l'**empreinte du contenu** copié |
| `ENV`, `USER`, `CMD`… | l'étape précédente + la valeur écrite |

???+ example "En vrai : les dépendances avant le code"

    ![Premier build en 15 s ; après modification de app.py, seule la dernière copie est rejouée, en 2 s](assets/captures/img_cache.png)

    `requirements.txt` n'a pas changé : l'installation reste en cache. `--no-cache-dir` empêche `pip` de laisser son propre cache dans la couche.

???+ danger "En vrai : le même projet, mal ordonné"

    ![Avec COPY . . avant pip install, chaque modification du code relance l'installation : 13 s](assets/captures/img_cache_ordre.png)

    Même schéma pour Node.js (`COPY package*.json ./` puis `npm ci`), Java (`pom.xml`) ou Go (`go.mod`, `go.sum`).

!!! tip "Cache et fraîcheur sont deux sujets"

    Le cache **ne voit pas le réseau** : un `RUN apk add` ou `pip install` en cache n'a pas revu les dépôts, et un tag de base a pu être republié.

    | Option | Effet |
    |---|---|
    | `--pull` | vérifie si la base a une version plus récente ; garde le reste du cache |
    | `--no-cache` | rejoue toutes les étapes, sans revérifier la base |
    | `--pull --no-cache` | les deux : pour une livraison ou après un correctif de sécurité |

## :material-shield-alert-outline: Ce qui part dans l'image

???+ danger "En vrai : supprimer après coup ne suffit pas"

    ![Le .env n'apparaît plus dans le conteneur, mais on le relit dans la couche du COPY extraite de l'image](assets/captures/img_fuite.png)

    Quiconque récupère l'image (`docker pull`, `docker image save`) peut lire la couche du `COPY`. La bonne approche : **exclure** (`.env`, `**/.env`, `secrets/` dans `.dockerignore`), puis monter le secret le temps d'une seule commande :

    ```dockerfile
    RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --omit=dev
    ```

    ```bash
    docker build --secret id=npmrc,src=$HOME/.npmrc -t app:1.0 .
    ```

    Les secrets d'**exécution**, eux, se montent au lancement : voir [Secrets, fichiers, réseau et ressources](Secrets-fichiers-reseau-ressources.md).

???+ example "En vrai : un build multi-étapes, de 353 Mo à 112 ko"

    ![L'étape de compilation est abandonnée ; l'image finale ne contient que le binaire, sans gcc ni shell](assets/captures/img_multi.png)

    L'étape `build` porte le compilateur ; seule la sortie passe par `COPY --from=build`. L'image finale n'a ni compilateur, ni sources, ni gestionnaire de paquets : moins de composants à suivre. Pour un serveur Python sans compilation, le gain serait faible.

??? note "Le même principe en Go, avec une base distroless"

    ```dockerfile
    FROM golang:1.24 AS build
    WORKDIR /src
    COPY go.* ./
    RUN go mod download
    COPY . .
    RUN CGO_ENABLED=0 go build -o /out/app .

    FROM gcr.io/distroless/static-debian12:nonroot
    COPY --from=build /out/app /app
    ENTRYPOINT ["/app"]
    ```

    La variante `nonroot` fait tourner le binaire sous un utilisateur non privilégié.

## :material-flask-outline: À toi de jouer

```bash
mkdir -p demo-ctx/public && cd demo-ctx
echo '<h1>ok</h1>' > public/index.html
head -c 50M /dev/urandom > public/gros.tmp
printf 'FROM busybox:1.37\nCOPY public/ /www/\n' > Dockerfile

echo '*.tmp' > .dockerignore
docker build --progress=plain -t demo-ctx . 2>&1 | grep 'transferring context: [0-9]'
docker run --rm demo-ctx ls /www                  # gros.tmp est là

echo '**/*.tmp' >> .dockerignore
docker build --progress=plain -t demo-ctx . 2>&1 | grep 'transferring context: [0-9]'
docker run --rm demo-ctx ls /www                  # gros.tmp a disparu

echo '<h1>v2</h1>' > public/index.html
docker build --progress=plain -t demo-ctx . 2>&1 | grep -E '^#[0-9]+ (\[[0-9]|CACHED)'
docker image rm demo-ctx && cd .. && rm -rf demo-ctx
```

??? abstract "Pour les créateurs : script de motion design (70 s)"

    Le Dockerfile affiché verticalement, une case par instruction ; à droite de chaque case, un témoin (vert « CACHED », rouge « rejoué ») et un chronomètre global en haut.

    | Séq. | Durée | À l'écran | Animation | Texte à l'écran |
    |---|---|---|---|---|
    | 1 | 0-8 s | Un dossier de projet (`.git`, `.env`, archive de 50 Mo, `app.py`) | Un tamis `.dockerignore` passe : `.git`, `.env` et l'archive tombent à côté | « Le constructeur ne reçoit que le contexte, filtré par .dockerignore. » |
    | 2 | 8-16 s | Premier build : les cases s'allument une à une | Témoins rouges, chronomètre à 15 s | « Premier build : toutes les étapes sont exécutées. » |
    | 3 | 16-24 s | Second build sans modification | Tous les témoins passent au vert, chronomètre sous 2 s | « Rien n'a changé : tout est réutilisé. » |
    | 4 | 24-36 s | Un crayon touche `app.py` | Les cases du haut restent vertes ; la case `COPY app.py` rougit, puis le rouge **coule** vers le bas | « Une entrée change : l'étape et toutes les suivantes sont rejouées. » |
    | 5 | 36-48 s | Même modification, Dockerfile mal ordonné (`COPY . .` avant `pip install`) | La longue case « installation » est rejouée, chronomètre qui s'emballe | « Mal ordonné, le moindre changement relance tout. » |
    | 6 | 48-58 s | Le dépôt de paquets affiche « nouvelle version » | La case `RUN pip` reste verte ; un point d'exclamation apparaît | « Le cache ne voit pas le réseau : vert ne veut pas dire à jour. » |
    | 7 | 58-66 s | Boutons `--pull` et `--no-cache` | `--pull` rafraîchit `FROM` ; `--no-cache` repeint tout en rouge | « --pull vérifie la base, --no-cache rejoue tout. » |
    | 8 | 66-70 s | Synthèse | Le Dockerfile se réordonne : stable en haut, changeant en bas | « Le stable en haut, ce qui change en bas. » |

    Moment clé : en séquence 4, le rouge **coule vers le bas** sans jamais remonter. Garder la même modification en séquences 4 et 5 pour comparer les chronomètres (2 s contre 13 s mesurés).

??? info "Pour les créateurs : idées de schémas"

    - **Deux ordres, deux temps** : deux colonnes ; à gauche `COPY . .` puis `pip install`, une longue barre rouge « installation » réapparaît à chaque modification ; à droite, seule une fine barre « copie du code » est rejouée. Chronomètres 13 s et 2 s.
    - **Le build multi-étapes** : sources, étape de compilation (compilateur, outils), flèche `COPY --from=build` vers l'image d'exécution (binaire seul) ; l'étape de compilation part en pointillés vers « abandonnée, non distribuée ».
    - **Trois notions distinctes** : une instruction, une étape de cache, une couche. Une étape peut être en cache sans produire de couche, et une couche ne correspond pas toujours à une ligne d'historique.
