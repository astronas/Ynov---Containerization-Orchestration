# Sécurité des images

<p class="lead">La sécurité d'un conteneur commence <strong>avant son exécution</strong> : une image transporte surtout du code qu'on n'a pas écrit. Il faut savoir d'où elle vient, ce qu'elle contient, comment la corriger, et ce qu'elle ne doit jamais contenir.</p>

![Une image réelle : 24 ko écrits, 175 Mo hérités, et les quatre contrôles qui l'examinent](assets/illustrations/securite-images.png){ .hero }

!!! abstract "Dans cette page"

    **Tu vas comprendre :**

    - pourquoi ton image contient beaucoup plus que ton code, avec les failles qui vont avec ;
    - comment être sûr de lancer toujours **exactement** la même image, et comment y chercher les failles connues ;
    - pourquoi un mot de passe « effacé » dans un Dockerfile reste lisible par tous.

    **Prérequis :** [Couches d'une image](Couches-d-une-image.md), [Isolation d'un conteneur](Isolation-des-conteneurs.md). **Durée :** 35 min. **Niveau :** débutant à intermédiaire.

!!! quote "En clair"

    Une image, c'est un **plat préparé** : tu ajoutes ta garniture (ton site) sur une base toute faite (Apache, Debian) que tu n'as pas cuisinée. Avant de la servir, tu regardes **qui l'a produite**, tu notes son **numéro de lot** pour racheter exactement la même, tu consultes les **avis de rappel** (les failles connues), et tu ne caches jamais la clé de chez toi dans la sauce. Limite de l'image : un plat se goûte, une image non. Il faut des outils pour regarder dedans.

## L'essentiel en 30 secondes

<div class="grid cards" markdown>

-   :material-layers-triple-outline:{ .lg .middle } __Hériter__

    ---

    Pour une page HTML de 24 ko, on fait tourner **175 Mo** d'Apache et de Debian, avec leurs failles.

-   :material-fingerprint:{ .lg .middle } __Identifier__

    ---

    Un **tag** (`11.4`) est une étiquette qu'on peut déplacer ; un **digest** désigne un contenu précis, au bit près.

-   :material-radar:{ .lg .middle } __Scanner__

    ---

    Un scan liste les failles **déjà connues**. Zéro alerte ne veut pas dire image sûre.

-   :material-key-alert-outline:{ .lg .middle } __Aucun secret__

    ---

    Un secret écrit dans une couche **y reste**, même supprimé ensuite, et part avec chaque copie de l'image.

</div>

!!! warning "À retenir"

    **On ne répare pas un conteneur qui tourne : on corrige l'image, on la reconstruit, on la teste, on la redéploie.** Et chaque contrôle (digest, signature, provenance, scan) répond à **une** question précise, jamais à « est-ce sûr ? ».

## :material-wall: Raisonner en frontières

!!! quote "En clair"

    Un château fort n'a pas un seul mur, mais plusieurs **remparts** successifs. Si l'ennemi passe le premier, le deuxième l'arrête. En sécurité, c'est pareil : on ne compte jamais sur une seule protection.

Un conteneur **partage le noyau de l'hôte**, le cœur de Linux (voir [Isolation d'un conteneur](Isolation-des-conteneurs.md)). Prenons un scénario concret : un attaquant trouve une faille dans ton site et peut y lancer des commandes. Ce qu'il obtient ensuite dépend de chaque rempart : ce que contient l'image, sous quel utilisateur tourne le programme, ce qu'on lui a monté, à qui il peut parler. On empile donc des protections **indépendantes**, une par niveau.

![Six frontières successives : l'attaque franchit l'image et l'application, puis bute sur le conteneur](assets/illustrations/defense-profondeur.png)

| Famille d'attaque | Exemples | Où se joue la protection |
|---|---|---|
| **Chaîne d'approvisionnement** (tout ce qu'on récupère pour fabriquer l'image) | image ou dépendance vulnérable, origine trompeuse | cette page |
| **Application** | injection SQL, exécution de code, mot de passe faible | le code et ses tests |
| **Configuration** | droits trop larges, ports ouverts, secrets lisibles | [Identités et privilèges](Identites-et-privileges.md), [Secrets, fichiers, réseau](Secrets-fichiers-reseau-ressources.md) |
| **Infrastructure** | socket du démon Docker, noyau, ressources partagées | idem, plus le durcissement de l'hôte |

Ces protections se complètent sans se remplacer : une configuration Docker stricte ne corrige pas une injection SQL dans ton code.

??? note "Le vocabulaire du risque et les biens à protéger"

    | Notion | Définition | Exemple |
    |---|---|---|
    | **Menace** | ce qui pourrait exploiter une faiblesse | accès non autorisé aux données |
    | **Scénario** | le chemin concret de l'attaque | une commande exécutée à travers l'application web |
    | **Vulnérabilité** | faiblesse exploitable | une CVE de l'image, une injection dans le PHP |
    | **Impact** | ce que permettrait la réussite | lecture de secrets, rebond vers un autre service |
    | **Risque** | probabilité × gravité | un service exposé à Internet et lancé en root |
    | **Mesure** | ce qui réduit probabilité ou impact | non root, permissions, réseau restreint, supervision |

    Les biens à protéger : les **données**, les **secrets** (usurpation, accès à d'autres services), l'**hôte Docker** (tous les autres services), le **registre et les images** (du code altéré distribué à tous), la **disponibilité**. La question utile n'est pas « mon conteneur est-il sécurisé ? » mais **« que permettrait cette compromission précise ? »**.

## :material-layers-search-outline: Ce qu'on hérite, et d'où ça vient

!!! quote "En clair"

    Ton `Dockerfile` commence par `FROM` : tu poses ta brique sur une pile de briques fabriquées par d'autres. Si l'une d'elles est fissurée, ta maison l'est aussi, même si ta brique est parfaite.

Avant d'adopter une image, on vérifie **qui la produit** (dépôt source, maintenance, mises à jour) et **ce qu'elle contient**. Le nombre de téléchargements ne prouve rien : un attaquant peut publier une copie piégée au nom presque identique.

???+ example "En vrai : 24 ko écrits, 175 Mo exécutés"

    **Ce qu'on fait :** on construit une image qui ajoute une seule page HTML à `httpd:2.4` (le serveur web Apache), puis on liste ses couches avec `docker image history`.

    ![docker image history d'une image construite sur httpd:2.4](assets/captures/sec_heritage.png)

    **Ce qu'il faut regarder :**

    - ① : la seule couche qu'on a écrite, notre `COPY`, pèse 24,6 ko.
    - ② : la couche qui installe Apache, héritée de `httpd:2.4`.
    - ③ : tout en bas, une Debian entière. Chaque paquet hérité a ses propres failles et son propre rythme de correctifs.
    - ④ : au total, 175 Mo exécutés pour 24 ko écrits. Une faille peut venir d'une **dépendance indirecte** (le paquet d'un paquet), même si notre code est parfait.

Pour désigner une image, on a deux moyens. Le **tag** (`mariadb:11.4`) est une étiquette : l'éditeur la recolle sur une nouvelle version à chaque correctif. Le **digest** (`sha256:d189…`) est l'empreinte calculée sur le contenu : il change dès qu'un seul octet change. Une image publiée pour plusieurs types de processeurs a un **index** (le sommaire) qui pointe vers un **manifeste** par plateforme (amd64 pour un PC, arm64 pour un Mac récent ou un Raspberry Pi).

???+ example "En vrai : labels OCI, digest de l'index et des manifestes"

    **Ce qu'on fait :** on lit les **labels** de `mariadb:11.4` (des étiquettes d'information écrites par l'éditeur), puis ses digests, en local et côté registre.

    ![Labels de mariadb:11.4 et digests vus par docker buildx imagetools](assets/captures/sec_digest.png)

    **Ce qu'il faut regarder :**

    - ① : les labels indiquent la base (Ubuntu), le dépôt source et la version réelle, 11.4.13, cachée derrière le tag `11.4`.
    - ② : le digest désigne **un** contenu précis, pas une étiquette.
    - ③ : côté registre, le digest de l'**index**, qui couvre toutes les plateformes…
    - ④ : … et un manifeste par plateforme, avec **son propre** digest.
    - ⑤ : les entrées `unknown/unknown` sont des **attestations** : des documents joints qui décrivent comment l'image a été construite.

???+ danger "Épingler un digest fige le contenu, pas sa qualité"

    ```yaml
    image: mariadb:11.4@sha256:d1891ede5a55...   # (1)!
    ```

    1. Le tag sert de repère pour les humains ; c'est le digest complet (ici raccourci) de l'index testé qui décide de l'image téléchargée.

    Le tag seul désignera une autre image au prochain correctif ; le digest garantit la même image, **failles comprises**. Scénario : une faille grave est publiée sur cette version de MariaDB dans trois mois ; ton serveur, épinglé, ne recevra jamais le correctif tant que tu ne changes pas le digest. On compare toujours des objets du même niveau (index avec index), et un outil comme Renovate ou Dependabot propose les nouveaux digests, à valider après tests.

| Contrôle | Répond à | Ne dit pas |
|---|---|---|
| **Digest** | « même contenu ? » | si ce contenu est sain |
| **Signature** | « quelle identité l'a signé ? » | si le code est sans faille |
| **Provenance** (attestation) | « comment et à partir de quoi ? » | si les sources étaient saines |
| **Scan** | « quelles failles **connues** ? » | ce qui n'est pas encore connu |

## :material-radar: Scanner, interpréter, corriger

!!! quote "En clair"

    Un scanner, c'est le **contrôle des avis de rappel** : il lit la liste des ingrédients de l'image (le SBOM) et la compare à la liste publique des produits rappelés (les CVE). Il ne peut pas signaler un défaut que personne n'a encore déclaré.

Un analyseur comme Trivy ou Docker Scout produit un rapport. Ce rapport n'est qu'un point de départ : on décide ligne par ligne.

???+ example "En vrai : 54 failles graves, une seule corrigeable"

    **Ce qu'on fait :** on lance Trivy depuis son image officielle sur deux images, en ne gardant que les failles graves (HIGH et CRITICAL). La troisième commande ajoute `--ignore-unfixed` : ne montrer que les failles qui ont déjà un correctif.

    ![Trivy sur alpine:3.22 puis httpd:2.4, avec et sans --ignore-unfixed](assets/captures/sec_scan.png)

    **Ce qu'il faut regarder :**

    - ① : `alpine:3.22`, très petite, ne signale aucune faille grave connue.
    - ② : `httpd:2.4`, construite sur Debian, en signale 54…
    - ③ : … mais **une seule** a déjà un correctif publié.
    - ④ : la faille CRITICAL n'a pas de correctif (colonne « corrigé » vide). Reconstruire n'y changera rien aujourd'hui : il faut **mitiger** (réduire le risque autrement) ou **accepter**, en l'écrivant.

| Question, pour chaque ligne importante | Si oui | Si non |
|---|---|---|
| Le composant est-il présent et utilisé ? | continuer | fausse alerte probable, à documenter |
| Un correctif existe-t-il ? | mettre à jour la base, reconstruire | mitiger : désactiver la fonction, filtrer l'accès |
| La fonction vulnérable est-elle atteignable ? | priorité haute | priorité plus basse |
| Décision | **corriger**, **mitiger** ou **accepter**, en écrivant pourquoi | |

!!! tip "Corriger, c'est reconstruire"

    ```bash
    docker build --pull --no-cache -t registre.exemple.fr/app:1.2.1 .   # (1)!
    trivy image registre.exemple.fr/app:1.2.1                           # (2)!
    docker push registre.exemple.fr/app:1.2.1                           # (3)!
    docker compose up -d                                                # (4)!
    ```

    1. `--pull` : retélécharge l'image de base pour avoir sa dernière version. `--no-cache` : rejoue toutes les étapes, donc aussi les installations de paquets.
    2. On vérifie que la faille a bien disparu.
    3. On envoie la nouvelle version au registre, puis on met le nouveau tag ou digest dans `compose.yaml`.
    4. Compose voit que l'image a changé et recrée le conteneur.

    Jamais de `docker exec web apt-get upgrade` dans un conteneur qui tourne : la correction est perdue à la prochaine recréation, et personne ne peut savoir ce qui a été changé.

## :material-key-alert-outline: Aucun secret dans l'image

!!! quote "En clair"

    Les couches d'une image sont des **calques transparents** empilés. Effacer un fichier ne gratte pas le calque du dessous : on pose un nouveau calque qui le **cache**. Quiconque décolle les calques retrouve le dessin d'origine.

`ENV`, `ARG` et les fichiers copiés laissent des traces dans l'image ou dans ses métadonnées (les informations jointes à l'image). Et une image poussée sur un registre ne se « dé-publie » pas : des copies existent peut-être déjà. Scénario : ta clé d'API se retrouve dans une image publique ; quelqu'un la télécharge, la retrouve en cinq minutes et utilise ton compte à tes frais.

???+ example "En vrai : ENV et ARG lisibles par tous"

    **Ce qu'on fait :** on construit une « mauvaise » image qui reçoit un jeton par `ENV`, une clé par `ARG` et un fichier par `COPY`, puis on la lit avec `docker image inspect` et `docker image history`, sans jamais la lancer.

    ![docker image inspect et docker image history révèlent les valeurs d'ENV et d'ARG](assets/captures/sec_secret_meta.png)

    **Ce qu'il faut regarder :**

    - ① : la valeur d'`ENV` est en clair dans la configuration de l'image.
    - ② : la valeur d'`ARG` est recopiée dans l'historique de chaque `RUN` qui suit.
    - ③ : le fichier copié a sa propre couche.

???+ danger "En vrai : le fichier supprimé est toujours dans la couche"

    **Ce qu'on fait :** on vérifie que le fichier a « disparu » du conteneur, puis on exporte l'image avec `docker image save` et on fouille ses couches une à une.

    ![Le jeton absent du conteneur mais retrouvé en extrayant les couches de docker image save](assets/captures/sec_secret_couche.png)

    **Ce qu'il faut regarder :**

    - ① : dans le conteneur, le fichier a bien disparu…
    - ② : … parce que `rm` a ajouté une couche avec un fichier spécial `.wh.token.txt` (*whiteout*, « effaceur ») qui le **masque**.
    - ③ : la couche du `COPY` contient toujours `token.txt`…
    - ④ : … et n'importe qui ayant l'image peut le relire.

**BuildKit**, le moteur de construction de Docker, sait prêter un fichier à une seule instruction `RUN` sans l'écrire dans l'image : c'est le **montage de secret**.

???+ example "En vrai : le montage de secret BuildKit ne laisse aucune trace"

    **Ce qu'on fait :** on construit une « bonne » image qui lit le jeton avec `RUN --mount=type=secret`, puis on fouille les deux images à la recherche des trois valeurs secrètes.

    ![Construction avec --secret : ni historique, ni fichier, ni trace dans les couches](assets/captures/sec_secret_buildkit.png)

    **Ce qu'il faut regarder :**

    - ① : le secret est monté **pendant ce `RUN` seulement**.
    - ② : l'historique garde la commande, mais aucune valeur.
    - ③ : le fichier n'existe pas dans l'image finale.
    - ④ : la fouille de la mauvaise image trouve 6 traces (via `ENV`, `ARG` et `COPY`)…
    - ⑤ : … et zéro dans la bonne.

    Pour éviter d'envoyer des secrets au constructeur par erreur, voir aussi le `.dockerignore` dans [Contexte de build, cache et .dockerignore](Contexte-de-build-et-cache.md).

## :material-flask-outline: À toi de jouer

Six étapes, environ 10 minutes. Tu vas cacher un faux secret dans une image, le retrouver, puis faire la même chose proprement. Tape les commandes une par une.

**Étape 1 · Préparer un faux secret et un Dockerfile maladroit**

```bash
mkdir -p ~/lab-secret && cd ~/lab-secret                                    # (1)!
echo "valeur-secrete" > token.txt && cat token.txt                          # (2)!
printf 'FROM alpine:3.22\nCOPY token.txt /tmp/\nRUN rm /tmp/token.txt\n' > Dockerfile.mauvais  # (3)!
cat Dockerfile.mauvais
```

1. Crée un dossier de travail dans ton dossier personnel (`~`) et entre dedans.
2. Écrit un faux secret dans `token.txt`, puis l'affiche.
3. Écrit un Dockerfile de trois lignes : `\n` signifie « retour à la ligne ». Il copie le secret, puis le supprime.

Tu dois voir le secret, puis le Dockerfile :

```text
valeur-secrete
FROM alpine:3.22
COPY token.txt /tmp/
RUN rm /tmp/token.txt
```

**Étape 2 · Construire, et croire que le secret a disparu**

```bash
docker build -q -f Dockerfile.mauvais -t lab:mauvais .   # (1)!
docker run --rm lab:mauvais ls /tmp/token.txt            # (2)!
```

1. `build` construit l'image. `-q` : n'affiche que son identifiant. `-f` : le Dockerfile à utiliser. `-t lab:mauvais` : le nom donné à l'image. Le `.` final : le dossier courant sert de contexte.
2. Lance un conteneur jetable (`--rm`) qui cherche le fichier.

Tu dois voir l'identifiant de l'image (le tien sera différent), puis le message « fichier introuvable » :

```text
sha256:4ba8fcca9f5f97e19b18203e8a554471d54d3c92a01e71b38e1200aa579a40ac
ls: /tmp/token.txt: No such file or directory
```

**Étape 3 · Fouiller les couches comme le ferait un curieux**

```bash
docker image save lab:mauvais -o mauvais.tar                                        # (1)!
mkdir -p couches && tar -xf mauvais.tar -C couches                                  # (2)!
for c in couches/blobs/sha256/*; do tar -tf "$c" 2>/dev/null | grep token; done     # (3)!
for c in couches/blobs/sha256/*; do tar -xOf "$c" tmp/token.txt 2>/dev/null; done   # (4)!
```

1. Exporte toute l'image dans une archive : c'est ce que reçoit quiconque télécharge ton image.
2. Décompresse l'archive dans le dossier `couches`.
3. Pour chaque couche, liste son contenu et garde les lignes qui contiennent « token ».
4. Pour chaque couche, essaie d'afficher le contenu de `tmp/token.txt`.

Tu dois voir le fichier, son « effaceur », puis le secret en clair :

```text
tmp/token.txt
tmp/.wh.token.txt
valeur-secrete
```

**Étape 4 · Le bon geste : prêter le secret au seul RUN qui en a besoin**

```bash
printf 'FROM alpine:3.22\nRUN --mount=type=secret,id=t wc -c /run/secrets/t\n' > Dockerfile.bon   # (1)!
docker build -q -f Dockerfile.bon --secret id=t,src=token.txt -t lab:bon .                       # (2)!
docker run --rm lab:bon cat /run/secrets/t                                                        # (3)!
docker image history --no-trunc --format '{{.CreatedBy}}' lab:bon | head -1                       # (4)!
```

1. Ce `RUN` reçoit le secret `t` dans `/run/secrets/t` et compte ses caractères (`wc -c`), comme le ferait une vraie étape qui en a besoin.
2. `--secret id=t,src=token.txt` : le secret nommé `t` vient du fichier `token.txt`.
3. Le secret est-il resté dans l'image ?
4. Que garde l'historique de la dernière étape ?

Tu dois voir l'identifiant (différent chez toi), un fichier introuvable, et une commande sans aucune valeur :

```text
sha256:cb08ddd861eef262ffada8bb16dfa5669a3652e22514fabd513c61b33e035cb2
cat: can't open '/run/secrets/t': No such file or directory
RUN /bin/sh -c wc -c /run/secrets/t # buildkit
```

**Étape 5 · Scanner deux images avec Trivy**

```bash
docker run --rm -v trivy-cache:/root/.cache aquasec/trivy:0.58.1 image -q --severity HIGH,CRITICAL alpine:3.22 | grep Total  # (1)!
docker run --rm -v trivy-cache:/root/.cache aquasec/trivy:0.58.1 image -q --severity HIGH,CRITICAL httpd:2.4 | grep Total
```

1. `docker run --rm` : Trivy tourne dans un conteneur jetable, rien à installer. `-v trivy-cache:/root/.cache` : garde sa base de failles dans un volume, pour ne la télécharger qu'une fois. `aquasec/trivy:0.58.1` : l'image officielle, version figée. `image -q --severity HIGH,CRITICAL alpine:3.22` : analyse cette image, sans bavardage, failles graves seulement. `| grep Total` : ne garde que la ligne de bilan.

Le premier lancement télécharge la base de failles (une minute environ). Tu dois voir deux bilans ; tes chiffres seront sans doute différents, car la base change chaque jour :

```text
Total: 0 (HIGH: 0, CRITICAL: 0)
Total: 54 (HIGH: 53, CRITICAL: 1)
```

**Étape 6 · Faire le ménage**

```bash
docker image rm lab:mauvais lab:bon   # (1)!
docker volume rm trivy-cache          # (2)!
cd ~ && rm -rf ~/lab-secret           # (3)!
```

1. Supprime les deux images du lab.
2. Supprime la base de failles téléchargée par Trivy. Tu peux aussi retirer Trivy lui-même : `docker image rm aquasec/trivy:0.58.1`.
3. Revient dans ton dossier personnel et supprime le dossier de travail.

Tu dois voir (identifiants différents chez toi) :

```text
Untagged: lab:mauvais
Deleted: sha256:4ba8fcca9f5f97e19b18203e8a554471d54d3c92a01e71b38e1200aa579a40ac
Untagged: lab:bon
Deleted: sha256:cb08ddd861eef262ffada8bb16dfa5669a3652e22514fabd513c61b33e035cb2
trivy-cache
```

??? tip "Ça ne marche pas ?"

    | Message | Cause | Solution |
    |---|---|---|
    | `"/token.txt": not found` pendant le build | tu n'es pas dans le dossier `lab-secret` | `cd ~/lab-secret` puis recommence |
    | `the --mount option requires BuildKit` | ancien constructeur de Docker | mets Docker à jour, ou préfixe la commande par `DOCKER_BUILDKIT=1` |
    | la boucle `for` de l'étape 3 n'affiche rien | Docker ancien : l'archive n'a pas de dossier `blobs` | `tar -tf mauvais.tar` pour voir sa structure ; les couches y sont des `layer.tar` |
    | Trivy semble bloqué | il télécharge sa base au premier lancement | patiente, puis relance |
    | `volume is in use` | un conteneur Trivy tourne encore | attends la fin du scan, puis recommence |

## :material-help-circle-outline: Vérifie que tu as compris

??? question "1. Un Dockerfile copie `cle.txt` puis fait `RUN rm cle.txt` à la ligne suivante. L'image publiée est-elle sans danger ?"

    **Non.** `rm` ajoute une couche qui **masque** le fichier, mais la couche du `COPY` le contient toujours. N'importe qui ayant l'image le retrouve avec `docker image save`. Pour un secret de construction, on utilise `RUN --mount=type=secret` ; à l'exécution, un secret monté (page [Secrets, fichiers, réseau et ressources](Secrets-fichiers-reseau-ressources.md)).

??? question "2. Trivy affiche `Total: 0` pour ton image. Peux-tu écrire « image sûre » dans ton rapport ?"

    **Non.** Trivy ne connaît que les failles **déjà publiées**, dans les paquets qu'il sait reconnaître. Il ne voit ni une faille encore inconnue, ni une injection SQL dans ton propre code. Tu peux écrire : « aucune faille HIGH ou CRITICAL connue à telle date ».

??? question "3. Tu épingles `mariadb:11.4@sha256:…` en production. Pourquoi cela ne te protège-t-il pas dans six mois ?"

    Le digest fige le contenu, **failles comprises**. Tant que tu ne mets pas à jour le digest (après tests), tu ne reçois aucun correctif. L'épinglage garantit la reproductibilité, pas la sécurité : il faut un outil ou une routine pour proposer les nouvelles versions.

!!! success "Et ensuite ?"

    Tu sais vérifier ce que contient une image et l'empêcher de transporter des secrets. Page suivante : [Identités, privilèges et capabilities](Identites-et-privileges.md), sous quel utilisateur et avec quels droits cette image va tourner.

## :material-server: Pour aller plus loin

??? note "Une chaîne de livraison avec des portes"

    ```mermaid
    flowchart LR
        S["Code et dépendances"] --> B["Build reproductible"]
        B --> T["SBOM · scan · secrets"]
        T --> G{"Conforme ?"}
        G -- non --> X["Rejet : non publiée"]
        G -- oui --> R["Registre : signée + attestations"]
        R --> V{"Signature et digest vérifiés ?"}
        V -- oui --> P["Déploiement"]
        V -- non --> X
    ```

    L'objectif est d'**empêcher** qu'une image non conforme arrive en production, pas de le constater après déploiement.

??? note "Alléger l'image, et produire SBOM et provenance au build"

    Une construction multi-étapes laisse le compilateur derrière elle (détails dans [Écrire un Dockerfile](Ecrire-un-Dockerfile.md)) :

    ```dockerfile
    FROM golang:1.23 AS build
    WORKDIR /src
    COPY . .
    RUN CGO_ENABLED=0 go build -o /app .

    FROM gcr.io/distroless/static-debian12:nonroot
    COPY --from=build /app /app
    ENTRYPOINT ["/app"]
    ```

    Plus de shell ni de gestionnaire de paquets : peu d'outils pour un intrus, peu de paquets à signaler. Mais **petit ne veut pas dire sûr** : il faut des correctifs rapides, une compatibilité vérifiée (Alpine utilise musl, pas glibc) et des dépendances encore visibles ; l'absence de shell complique aussi le diagnostic.

    `docker buildx build --sbom=true --provenance=mode=max ... --push .` attache à l'image la liste des paquets et la description du build. Effet constaté : reconstruire la même image depuis le cache change son identifiant local, car le digest de l'**index** inclut l'attestation régénérée. Même contenu exécutable, digest différent.

??? abstract "Pour les créateurs : script de motion design « Le voyage d'une image » (70 s)"

    Style : fond sombre, une image représentée comme une pile de briques colorées, une porte de contrôle par étape. Vert pour ce qui passe, rouge pour ce qui est bloqué.

    | Séq. | Durée | À l'écran | Animation | Texte à l'écran |
    |---|---|---|---|---|
    | 1 | 0-8 s | Une petite brique « code » posée sur une haute pile de briques grises « dépendances » | La caméra descend le long de la pile, qui paraît sans fin | « Ce qu'on écrit est la partie visible. Le reste, on l'hérite. » |
    | 2 | 8-16 s | Deux images côte à côte : « officielle » et « copie au nom proche », chacune avec un compteur de téléchargements géant | Les compteurs tournent ; une loupe se pose sur l'étiquette du producteur et révèle « inconnu » pour la copie | « Populaire ne veut pas dire fiable. On vérifie qui la produit. » |
    | 3 | 16-25 s | Une étiquette `mariadb:11.4` attachée à une pile ; elle se décroche et va se coller sur une autre pile | Puis une empreinte `sha256` s'imprime directement dans la pile et ne bouge plus | « Un tag se déplace. Un digest désigne un contenu. » |
    | 4 | 25-35 s | Un scanner balaie la pile de briques | Trois briques s'allument en rouge avec un badge « CVE » ; l'une porte « correctif disponible », une autre « non atteignable » | « Scanner, puis interpréter : présent ? corrigé ? atteignable ? » |
    | 5 | 35-44 s | Un développeur tape `ENV API_TOKEN=…` ; une brique dorée « secret » s'insère dans la pile | Une main tente de retirer la brique dorée par-dessus (`rm`) : elle reste visible au travers, comme sous une vitre | « Un secret écrit dans une couche y reste. » |
    | 6 | 44-52 s | La même scène avec un tunnel `--mount=type=secret` | La brique dorée traverse le tunnel pendant le build puis disparaît ; la pile finale n'en garde aucune trace | « Le secret sert au build, il ne devient pas une couche. » |
    | 7 | 52-62 s | Une chaîne de portes : build, scan, signature, registre, déploiement | Une image non conforme est arrêtée à la porte « scan » (flash rouge) ; l'autre passe toutes les portes et reçoit un sceau « signée » | « Bloquer avant le déploiement, pas constater après. » |
    | 8 | 62-70 s | Un conteneur en marche avec une clé à molette « apt upgrade » barrée ; à côté, une flèche circulaire « reconstruire, tester, redéployer » | La flèche tourne, l'ancien conteneur s'efface, un nouveau apparaît | « On ne répare pas un conteneur. On remplace l'image. » |

    La séquence 5 porte l'idée la plus contre-intuitive : montrer que la suppression **ajoute** une couche par-dessus sans effacer celle du dessous (une vitre qui recouvre la brique dorée). La capture `sec_secret_couche` en est la preuve réelle (`.wh.token.txt`). Garder le même jeu de couleurs que les illustrations.

??? info "Pour les créateurs : schémas"

    - **L'iceberg** (illustration d'en-tête) : chiffres réels de `docker image history` sur une image `httpd:2.4` + `index.html` (24,6 ko au-dessus de l'eau ; 34,9 Mo, 7 Mo et 87,7 Mo dessous ; 54 CVE HIGH ou CRITICAL relevées par Trivy).
    - **Les remparts** (défense en profondeur) : une flèche rouge « attaque » franchit les deux premiers et s'arrête au troisième.
    - **Quatre questions autour d'une image** : digest, signature, provenance, scan, avec sous chaque bulle, en gris, ce qu'elle ne prouve pas.
