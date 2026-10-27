"""Prépare les sources du site Zensical à partir du dépôt, sans modifier les pages d'origine.

- README.md devient la page d'accueil (index.md), avec ses liens adaptés ;
- les encadrés GitHub (> [!NOTE], > [!IMPORTANT]…) deviennent des admonitions (!!! note …),
  que Zensical sait afficher. Les pages du dépôt gardent la syntaxe GitHub.

Le résultat est écrit dans build_docs/ (ignoré par Git), que zensical.toml désigne comme docs_dir.
"""
import re
import shutil
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
SOURCE = RACINE / "docs"
CIBLE = RACINE / "build_docs"

# Type d'encadré GitHub -> (type d'admonition, titre affiché)
ENCADRES = {
    "NOTE": ("note", "Note"),
    "TIP": ("tip", "Astuce"),
    "IMPORTANT": ("warning", "À retenir"),
    "WARNING": ("danger", "Attention"),
    "CAUTION": ("danger", "Prudence"),
}
DEBUT = re.compile(r"^>\s*\[!(" + "|".join(ENCADRES) + r")\]\s*(.*)$")
# Début de liste ou de tableau : Python-Markdown exige une ligne vide avant, GitHub non.
BLOC = re.compile(r"^(\s*([-*+]|\d+\.)\s|\s*\|)")


def encadres_vers_admonitions(texte):
    lignes, sortie, i = texte.split("\n"), [], 0
    while i < len(lignes):
        m = DEBUT.match(lignes[i])
        if not m:
            sortie.append(lignes[i])
            i += 1
            continue
        genre, titre = ENCADRES[m.group(1)]
        sortie.append(f'!!! {genre} "{titre}"')
        sortie.append("")
        if m.group(2):
            sortie.append("    " + m.group(2))
        i += 1
        while i < len(lignes) and lignes[i].startswith(">"):
            contenu = lignes[i][1:]
            contenu = contenu[1:] if contenu.startswith(" ") else contenu
            precedent = sortie[-1].strip() if sortie else ""
            if BLOC.match(contenu) and precedent and not BLOC.match(precedent):
                sortie.append("")
            sortie.append(("    " + contenu) if contenu.strip() else "")
            i += 1
        sortie.append("")
    return "\n".join(sortie)


def accueil(readme):
    texte = readme.replace("](docs/", "](")
    return encadres_vers_admonitions(texte)


def main():
    shutil.rmtree(CIBLE, ignore_errors=True)
    shutil.copytree(SOURCE, CIBLE)
    for page in CIBLE.glob("*.md"):
        texte = page.read_text(encoding="utf8").replace("](../README.md)", "](index.md)")
        page.write_text(encadres_vers_admonitions(texte), encoding="utf8", newline="\n")
    (CIBLE / "index.md").write_text(accueil((RACINE / "README.md").read_text(encoding="utf8")), encoding="utf8", newline="\n")
    print(f"{len(list(CIBLE.glob('*.md')))} pages préparées dans {CIBLE.name}/")


if __name__ == "__main__":
    main()
