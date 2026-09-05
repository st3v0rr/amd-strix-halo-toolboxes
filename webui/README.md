# Strix Halo WebUI

Ein Webinterface für die llama.cpp-Toolboxes dieses Repositories: Modelle
herunterladen und verwalten, Server starten und stoppen, Live-Logs mitlesen,
Images und die App selbst aktualisieren — alles im Browser statt per SSH.

Läuft als `systemd --user`-Dienst auf der Strix-Halo-Box und startet nach einem
Reboot automatisch mit.

## Installation

```bash
git clone https://github.com/st3v0rr/amd-strix-halo-toolboxes.git
cd amd-strix-halo-toolboxes/webui
./install.sh
```

Der Installer prüft die Voraussetzungen, baut das Frontend, legt die
Konfiguration an, installiert die systemd-Unit und aktiviert Lingering. Am Ende
gibt er die URL und ein **einmalig angezeigtes** Passwort aus.

### Als normaler Benutzer oder als root?

Der Installer erkennt beides und wählt die passende Betriebsart:

| | als normaler Benutzer | als root |
|---|---|---|
| Unit | `systemd --user` + Lingering | System-Unit in `/etc/systemd/system` |
| Podman | rootless | rootful |
| Konfiguration | `~/.config/strix-halo-webui/` | `/root/.config/strix-halo-webui/` |
| Autostart | über Lingering | über `WantedBy=multi-user.target` |

Entscheidend ist, **wem deine Podman-Images und Container gehören**. Wer die Box
bisher als root bedient hat, sollte auch so installieren — sonst sieht die App
die vorhandenen Images nicht und müsste alles neu ziehen.

Der Preis der root-Variante: Wer das Webinterface übernimmt, ist root. Im LAN
hinter einer Firewall ist das für viele akzeptabel; wer es strenger mag, legt
einen eigenen Benutzer an, fügt ihn den Gruppen `video` und `render` hinzu und
installiert als dieser Benutzer.

Optionen:

```
--port PORT           Port des Webinterfaces (Default 8420)
--bind ADDR           Bind-Adresse (Default 0.0.0.0; 127.0.0.1 hinter einem Reverse-Proxy)
--models-dir DIR      Modellverzeichnis (Default ~/models)
--open-firewall       firewall-cmd fuer den Port ausfuehren
--no-start            Unit installieren, aber nicht starten
```

Ein erneuter Lauf ist idempotent und überschreibt die Zugangsdaten nicht.

### Voraussetzungen

| Werkzeug | Nötig für | Fehlt es? |
|---|---|---|
| Node ≥ 20.11 | die App | `sudo dnf install nodejs22` |
| podman | Container | `sudo dnf install podman` |
| git | Self-Update | Pflicht |
| python3 | VRAM-Schätzer | Schätzung bleibt deaktiviert |
| `hf` | Modell-Downloads | `pipx install "huggingface_hub[cli]"` |

Der Benutzer muss in den Gruppen `video` und `render` sein, sonst schlägt
`--device /dev/kfd` fehl:

```bash
sudo usermod -aG video,render "$USER"   # danach neu anmelden
```

## Modelle laden

Unter **Modelle → Modell herunterladen** wird ein Repository auf Hugging Face
gesucht und eine Quantisierung ausgewählt. Der Dialog schließt sich, sobald der
Download angelegt ist — ab da steht er in der Tabelle **Downloads** auf
derselben Seite, mit Fortschritt, Tempo und Restzeit.

Die Tabelle ist die einzige Stelle, an der ein Download gesteuert wird:

- **Abbrechen** hält ihn an. Angefangene Dateien bleiben liegen.
- **Fortsetzen** nimmt einen abgebrochenen, fehlgeschlagenen oder durch einen
  Neustart unterbrochenen Download wieder auf; `hf` setzt an den vorhandenen
  Teildateien an, lädt also nicht von vorn.
- **Verwerfen** räumt einen erledigten Eintrag weg.

Fertige Downloads verschwinden aus der Tabelle und stehen darüber in der
Modell-Liste. Der Fortschritt hängt nicht am Browser: Die Seite darf geschlossen
werden, der Download läuft auf der Box weiter, und ein Dienstneustart macht aus
ihm einen Eintrag „Unterbrochen“ statt eines verlorenen Downloads.

### Vision-Modelle

Multimodale Modelle brauchen neben den Gewichten einen Projektor
(`mmproj-*.gguf`). Beim Download eines Vision-Repos ist er einfach mit
auszuwählen; er landet neben der Quantisierung im selben Ordner.

Auf der Modell-Seite steht er nicht bei den Modellen, sondern in einer eigenen
Tabelle **Vision-Projektoren** — allein startbar ist er nicht. Im Dialog
**Server starten** wird er zum gewählten Modell automatisch gefunden und als
`--mmproj` übergeben; das Feld lässt sich auf einen anderen Projektor umstellen
oder leeren. Gesucht wird im Ordner des Modells und eine Ebene darüber, damit
auch große Quantisierungen in einem eigenen Shard-Ordner ihren Projektor finden.

Ohne Projektor startet ein Vision-Modell zwar, nimmt aber keine Bilder an.

### Speculative Decoding (MTP)

Im Start-Dialog und im Profil steht **Speculative Decoding**. Das Modell rät
dabei mehrere Tokens im Voraus und prüft sie in einem Durchgang — schneller,
solange die Entwürfe meistens stimmen. Voreingestellt ist **Aus**, wie in
llama.cpp selbst.

| Auswahl | Flag | Wofür |
| :--- | :--- | :--- |
| MTP | `--spec-type draft-mtp` | Nutzt die Multi-Token-Prediction-Layer *im Modell*. Nur Modelle, die damit trainiert wurden, haben sie — Qwen3-Next, DeepSeek V3, GLM-4.x. |
| N-Gram | `--spec-type ngram-mod` | Rät aus Wiederholungen im Kontext, braucht nichts vom Modell. Hilft bei Code und strukturierter Ausgabe. |

**Entwürfe pro Schritt** ist `--spec-draft-n-max`, llama.cpp-Default 3. Mehr
Entwürfe zahlen sich nur aus, solange sie meistens akzeptiert werden.

Die übrigen Strategien von llama.cpp (`draft-simple`, `draft-eagle3`, …)
stehen nicht zur Auswahl: sie brauchen ein zweites, kleineres Draft-Modell über
`-md`, wovon diese App nichts weiß.

Ob ein Modell MTP-Layer hat, ist ihm von außen nicht anzusehen — die Auswahl
bleibt deshalb deine. Falsch gewählt ist nicht gefährlich, llama.cpp hat dann
nur nichts zu raten. Ob das *Image* die Flags kennt, wird dagegen geprüft: bei
einem zu alten Build wird der Start abgelehnt, statt ihn in eine stille
Neustart-Schleife laufen zu lassen.

Siehe auch [docs/speculative.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md)
von llama.cpp.

### Download bleibt bei 0 % stehen

Mit gesetztem Token lädt `huggingface_hub` über **Xet**, und dieser Weg bleibt
in manchen Netzen ohne Fehlermeldung hängen — auch auf der Konsole, unabhängig
von dieser Anwendung. Zwei Wege aus der Sackgasse, beide unter
**Einstellungen → Hugging Face**:

- **Xet-Übertragung deaktivieren** — erzwingt einfaches HTTPS
  (`HF_HUB_DISABLE_XET=1`). Der Token bleibt nutzbar, gated Repositories also
  weiterhin erreichbar. Das ist meist die bessere Wahl.
- **Token entfernen** — öffentliche Repos laden dann wieder ohne Xet.

## ComfyUI

Neben llama.cpp lässt sich **ComfyUI** für Bild- und Videogenerierung betreiben.
Grundlage ist kyuz0s zweites Repo,
[amd-strix-halo-comfyui-toolboxes](https://github.com/kyuz0/amd-strix-halo-comfyui-toolboxes).
Dessen Image ist wie die llama.cpp-Toolboxen eines zum Reinsteigen; dieser Fork
baut daraus `toolboxes_comfyui/Dockerfile.comfyui`, das ComfyUI direkt startet.

Auf der Server-Seite legt **ComfyUI starten** einen Container an — Image-Kanal
(`comfyui` stabil, `comfyui-dev`), Host-Port, Name. Mehr braucht es nicht: kein
Modell (das nennt der Workflow selbst), kein Context, kein API-Key. Auf der
Detailseite führt **Oberfläche öffnen** zur ComfyUI-Weboberfläche.

> [!WARNING]
> ComfyUI hat **keine Anmeldung**. Wer den Port erreicht, kann Workflows
> ausführen und Dateien auf der Box lesen und schreiben. Behandle ihn wie den
> RPC-Port: nur im vertrauten Netz freigeben, siehe [Netzwerk und
> Firewall](#netzwerk-und-firewall).

Zwei Dinge unterscheiden das Fork-Image vom Original, beide nötig für den
Serverbetrieb:

- `--listen 0.0.0.0`. Upstreams Alias hat es nicht, ComfyUI bindet dann
  `127.0.0.1` — im Container heißt das, dass ein veröffentlichter Port ins Leere
  zeigt.
- `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL` und `TORCH_BLAS_PREFER_HIPBLASLT`
  als `ENV`. Upstream setzt sie in `/etc/profile.d/`, was nur eine Login-Shell
  liest; ein Container, der direkt Python startet, bekäme sie nicht und liefe
  langsamer, ohne dass etwas darauf hinweist.

### ComfyUI-Modelle

Eigene Seite, getrennt von den GGUFs: andere Ordner, andere Dateien, andere
Werkzeuge. Sie zeigt die acht Ordner, die ComfyUI kennt (`checkpoints`,
`loras`, `vae`, `diffusion_models`, …) mit Größe und Inhalt — leere inklusive,
weil ein leeres `loras/` eine Aussage ist. Ordner, die ComfyUI *nicht* liest,
werden als **unbekannt** markiert: dort belegen Dateien Platz, ohne je gefunden
zu werden.

**Herunterladen** startet die Skripte, die im Image liegen (`get_wan22.sh`,
`get_qwen_image.sh`, `get_ltx2.sh`, `get_hunyuan15.sh`, `get_minimax_h3.sh`) in
einem Wegwerf-Container mit dem Modellverzeichnis gemountet. Die Skripte sind
getestet, kennen die richtigen Zielordner und setzen abgebrochene Downloads
fort — deshalb werden sie benutzt statt nachgebaut. Der Fortschritt läuft über
dieselbe Download-Liste wie die GGUF-Downloads.

Bei den meisten Familien muss zuerst der Eintrag **Gemeinsame Teile** geladen
werden; er bringt Text-Encoder und VAEs, auf die die eigentlichen Modelle
aufbauen.

**Löschen** verlangt, dass ComfyUI vorher gestoppt ist. Anders als bei einem
llama-Server, dessen Modell in seinen Labels steht, lässt sich von außen nicht
sagen, welche Datei ein Workflow gerade lädt.

## Netzwerk und Firewall

Die Seite **Netzwerk** führt beides zusammen: alle Schnittstellen der Box mit
Adressen, Linkgeschwindigkeit, MAC und MTU — und darunter die Ports, die durch
die Firewall müssen. Je Port zwei Wege: **für alle freigeben** oder **nur für
eine Quelle**, also für eine IP-Adresse oder ein Subnetz. Der zweite Weg legt
eine Rich Rule an, genau in dieser Form:

```
rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" accept
```

Bestehende Regeln dieser Form werden gelesen und in der Portzeile angezeigt —
ein Port, der nur für das Cluster-Subnetz offen ist, steht dort als **„nur für
Quelle“** und nicht als „gesperrt“. Alles, was firewalld sonst noch kann
(Services, `log`, `reject`, Weiterleitungen), wird unverändert angezeigt, aber
nicht angefasst: Eine Regel, deren Wirkung die Anwendung nicht vollständig
beschreiben kann, entfernt sie auch nicht.

Welche Ports das sind, wird nicht gepflegt, sondern hergeleitet: der eigene Port
aus den Einstellungen, dazu je ein Port pro llama-server und pro RPC-Worker. Ein
Server, der vor fünf Minuten gestartet wurde, steht dort ohne weiteres Zutun,
und ein Port, der für einen längst gelöschten Server offen ist, fällt auf.

Fedora bringt firewalld mit, und dessen Standardzonen lassen keinen der hier
relevanten Ports durch. Je nachdem, was auf der Maschine läuft, sind es bis zu
drei:

| Port | Wofür | Geschützt durch |
|---|---|---|
| 8420 | das Webinterface selbst | Passwort + JWT-Cookie |
| 11434 | llama-server (Default je Server) | `--api-key` |
| 50052 | RPC-Worker (`ggml-rpc-server`) | **nichts** |

Zwei Dinge macht die Oberfläche bewusst nicht:

- **Kein `firewall-cmd --reload`.** Ein Reload reißt podmans eigene
  Weiterleitungsregeln mit, und laufende Container sind danach nicht mehr
  erreichbar, obwohl sie laufen. Stattdessen wird jede Änderung zweimal
  angewandt — einmal für die laufende Firewall, einmal dauerhaft. Gleiches
  Ergebnis, kein Reload. (Wer doch einmal reloadet und danach einen Container
  nicht erreicht: Container neu starten.)
- **Keine fremden Regeln anfassen.** Ports, die zu keinem verwalteten Dienst
  gehören — SSH etwa —, werden angezeigt, aber nicht angeboten. Ein Knopf, der
  Port 22 schließen kann, ist ein Knopf, der die eigene Sitzung beendet.

Läuft das Webinterface **nicht als root**, verweigert polkit den Zugriff auf
firewalld. Dann zeigt die Seite denselben Stand, nur mit den Befehlen statt der
Schalter:

```bash
sudo firewall-cmd --add-port=11434/tcp              # sofort
sudo firewall-cmd --permanent --add-port=11434/tcp  # und nach dem Neustart
sudo firewall-cmd --list-ports
```

Für das Webinterface selbst erledigt das schon der Installer mit
`--open-firewall`. Ein zweiter Server auf einem anderen Port braucht dessen Port
zusätzlich — 11435, 11436 und so weiter.

Adressen vergibt die Oberfläche nicht. Eine Schnittstelle umzukonfigurieren,
während die Seite über genau diese Schnittstelle ausgeliefert wird, ist der
kürzeste Weg zu einer Box, die Tastatur und Monitor braucht — der `nmcli`-Befehl
dafür steht [weiter unten](#übersicht).

### Der RPC-Port ist ein Sonderfall

`ggml-rpc-server` kennt **keine Authentifizierung** — llama.cpp warnt beim Start
selbst in Großbuchstaben davor. Wer Port 50052 erreicht, kann auf der GPU dieser
Maschine rechnen lassen und ihren Speicher belegen. Deshalb nicht pauschal
aufmachen, sondern nur für die Adressen, die ihn wirklich brauchen, also den
Master des Clusters.

Genau dafür ist auf der Netzwerkseite **„Nur für Quelle“** da: Port 50052 steht
dort auch dann, wenn gerade kein Worker läuft — die Freigabe richtet man
üblicherweise ein, bevor der Worker das erste Mal startet. Von Hand:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.100.0/24" port port="50052" protocol="tcp" accept'
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

Das Subnetz durch das eigene ersetzen. Wer strenger sein will, gibt statt des
Netzes die einzelne Adresse des Masters an (`source address="192.168.100.10/32"`).
Bei USB4-Direktverbindungen ist jede Strecke ein eigenes kleines Subnetz — dann
pro Strecke eine Regel.

Fehlt die Freigabe, sieht das Symptom nach einem Anwendungsfehler aus, ist aber
keiner: der Master meldet den Knoten beim Preflight als nicht erreichbar
(Zeitüberschreitung), und im Log des Workers steht dazu **nichts** — die Pakete
kommen dort nie an. Ein Worker, dessen Port offen ist, protokolliert jeden
Verbindungsversuch.

## Übersicht

Die Startseite zeigt live, was die Box gerade tut: GPU-Auslastung, GTT- und
VRAM-Belegung, Temperatur, CPU, Arbeitsspeicher, freier Plattenplatz, Laufzeit
und die laufenden Server mit ihren Container-Werten. Alle Kacheln führen zehn
Minuten Verlauf mit.

Darunter steht eine Tabelle mit **jeder Netzwerkschnittstelle**, die der Kernel
kennt, mit ihrer IP-Adresse samt Präfix, dem aktuellen Durchsatz je Richtung,
den Zählern seit dem Systemstart und einem Verlauf des Gesamtdurchsatzes.
Adressen, die niemand vergeben hat (`fe80::`, `169.254.`), stehen nicht als
gleichwertig daneben, sondern als **„nur Link-Local, nicht konfiguriert“** — das
ist der Normalzustand eines frisch eingesteckten USB4-Kabels und etwas anderes
als „keine IP“. Die Liste ist nirgends fest verdrahtet:

- Steckt ein USB4- oder Thunderbolt-Kabel zu einer zweiten Strix-Halo-Box, taucht
  die neue Schnittstelle (meist `thunderbolt0`) beim nächsten Tick von selbst auf
  — mit Kennzeichnung **USB4/TB** und der ausgehandelten Linkgeschwindigkeit. Für
  verteilte Inferenz über llama.cpp-RPC ist das die Stelle, an der man sieht, ob
  der schnelle Link überhaupt benutzt wird.
- Die Rate eines solchen Links kommt nicht aus `/sys/class/net/<if>/speed` —
  `thunderbolt-net` beantwortet diese Abfrage nicht —, sondern vom
  Thunderbolt-Gerät selbst, samt Anzahl der Lanes. Zwei Lanes à 20 Gbit/s
  ergeben die 40 Gbit/s, für die das Kabel verkauft wurde; steht dort nur
  **1 Lane**, hat die Verbindung die Hälfte ausgehandelt, und das liegt fast
  immer am Kabel oder am Port.
- Eine IP bekommt so ein Link von niemandem geschenkt. Steht in der Zeile „nur
  Link-Local“, fehlt sie noch — auf beiden Maschinen je einmal setzen, dann
  laufen RPC-Verbindungen darüber:

  ```bash
  # Box A; auf Box B dasselbe mit .12
  nmcli con add type ethernet ifname thunderbolt0 con-name tb0 \
    ip4 192.168.100.11/24
  nmcli con up tb0
  ```

- Die Einordnung kommt aus sysfs (an welchem Bus die Karte hängt), nicht aus dem
  Namen — ein USB4-Adapter, den der Kernel `eno2` nennt, wird trotzdem als solcher
  erkannt.
- Virtuelle Schnittstellen (Container-Bridges, `veth`-Paare, VPNs) stehen hinter
  einem Schalter, damit sie die physischen Links nicht verdrängen.
- Zählt eine Schnittstelle Fehler, steht das rot in ihrer Zeile — bei USB4 meist
  ein Kabel- oder Steckproblem.

Auf einem Rechner ohne `/proc/net/dev` (etwa einem Mac zur Entwicklung) entfällt
der Abschnitt ersatzlos, wie die GPU-Kacheln auch.

## Betrieb

Als normaler Benutzer:

```bash
systemctl --user status  strix-halo-webui
systemctl --user restart strix-halo-webui
journalctl --user -u strix-halo-webui -f
```

Als root (System-Unit — ohne `--user`):

```bash
systemctl status  strix-halo-webui
systemctl restart strix-halo-webui
journalctl -u strix-halo-webui -f
```

Benutzername und Passwort ändern: in der Weboberfläche unter **Einstellungen →
Konto**. Beides braucht das aktuelle Passwort als Bestätigung; andere
angemeldete Sitzungen werden dabei abgemeldet.

Zugang verloren? Auf der Box:

```bash
webui/scripts/shx-passwd                      # Passwort interaktiv setzen
webui/scripts/shx-passwd --generate           # neues erzeugen und anzeigen
webui/scripts/shx-passwd --username steve     # nur umbenennen
webui/scripts/shx-passwd --username steve --generate   # beides
```

Neu starten geht auch aus der Oberfläche: **Einstellungen → Dienst → Dienst neu
starten**. Laufende Container bleiben davon unberührt; ein laufender Download
bricht ab und lässt sich danach fortsetzen.

Funktionsprüfung einer laufenden Instanz:

```bash
SHX_PASSWORD=… webui/scripts/smoke.sh http://box:8420
```

## Was wo liegt

| Pfad | Inhalt |
|---|---|
| `~/.config/strix-halo-webui/config.json` | Zugangsdaten, JWT-Secret, HF-Token, Einstellungen (0600) |
| `~/.config/strix-halo-webui/profiles.json` | Server-Profile inkl. API-Keys (0600) |
| `~/.local/state/strix-halo-webui/state.json` | Job-Historie, Image-Digests, Feature-Cache |
| `~/.local/state/strix-halo-webui/app.log` | Anwendungslog, rotiert bei 5 MB |
| `~/models` (konfigurierbar) | die GGUF-Dateien |

Konfiguration und Zustand liegen **außerhalb** des Repositories, damit ein
`git pull` beim Self-Update sie nicht anfassen kann.

## Sicherheit

Die App ist ein **Gerät für ein vertrauenswürdiges LAN**, kein internetfähiger
Dienst. Sie bringt kein TLS mit; für eine Veröffentlichung gehört ein
Reverse-Proxy davor und `--bind 127.0.0.1`.

Was sie tut:

- Ein Admin-Konto, Passwort per scrypt gehasht, JWT in einem
  httpOnly-Cookie (`SameSite=Strict`, 12 h).
- Eine Änderung von Benutzername oder Passwort beendet alle anderen Sitzungen
  sofort. Ohne das bliebe ein fremder Zugriff nach einem Passwortwechsel noch
  bis zu 12 Stunden bestehen — genau der Fall, für den man das Passwort
  wechselt.
- CSRF-Schutz dreifach: SameSite, Origin-Abgleich und ein Pflicht-Header
  `X-Requested-With`. CORS ist gar nicht erst aktiviert.
- Login-Drosselung: 5 Versuche je 15 Minuten und IP.
- Kein Shell-Aufruf, nirgends — alle Subprozesse laufen mit Argv-Arrays
  (per ESLint-Regel erzwungen).
- Modellpfade werden gegen Traversal *und* Symlink-Ausbrüche geprüft.
- Nur Images aus `docker.io/st3v0rr/amd-strix-halo-toolboxes` sind erlaubt;
  beliebige Referenzen lassen sich in den Einstellungen freischalten.
- HF-Token und API-Keys werden aus Logs, SSE-Streams und Fehlermeldungen
  entfernt.

Bekannter Vorbehalt: der API-Key eines Servers steht im Container-Argv und ist
über `podman inspect` für jeden Prozess desselben Benutzers sichtbar — genauso
wie bei `run-llama-server.sh`. Wer das vermeiden will, kann llama-server
stattdessen `--api-key-file` mit einer Datei im Models-Mount übergeben (über
das Feld „Zusätzliche Argumente").

## Wie das Starten funktioniert

Das Backend baut das `podman run`-Argv selbst, als exakte Portierung von
`run-llama-server.sh`. Dass beide identisch sind, wird nicht behauptet, sondern
geprüft:

```bash
npm run test:parity
```

Dabei läuft das **echte** Skript gegen ein Fake-podman, das nur seine Argumente
ausgibt, und das Ergebnis wird mit dem unseres Builders verglichen.

Zwei Eigenheiten aus dem Skript sind dabei besonders wichtig:

- Auf Strix Halo sind Flash Attention und kein mmap zwingend. Die Schreibweise
  hat sich geändert (`-fa 1 --no-mmap` → `-fa on --load-mode none`), deshalb
  wird sie am Image ermittelt und pro **Image-ID** zwischengespeichert — nach
  einem Pull erkennt die App automatisch neu.
- Fehlt die Modelldatei, wird der Start verweigert. Sonst bricht llama-server
  ab und `--restart unless-stopped` erzeugt eine stille Neustart-Schleife.
  Für den Vision-Projektor gilt dasselbe, aus einem schlimmeren Grund: ein
  fehlender Projektor stoppt den Server nicht, er lässt nur jede Bildanfrage
  scheitern — ohne dass im Log etwas auf die Ursache zeigt.

Container werden mit `shx.*`-Labels markiert. Damit erkennt die App ihre
eigenen wieder — auch nach einem Reboot oder einem gelöschten `state.json` —
und lässt von Hand gestartete Container in Ruhe.

### Aus einem laufenden Server ein Profil machen

Auf der Serverdetailseite legt **Als Profil speichern** den Profil-Dialog mit
den Werten des Containers an — Modell, Projektor, Speculative Decoding, Image,
Context, GPU-Layers, Threads, Port, Zusatzargumente und RPC-Knoten. Gespeichert
wird erst, wenn du im Dialog auf Speichern gehst; Name und Autostart setzt du
dort noch selbst.

Der API-Key wird mit übernommen, damit ein Start aus dem Profil denselben Key
hat wie der laufende Server und Clients nichts umstellen müssen. Er steht
bewusst nicht in den Labels — dort könnte ihn jeder Prozess dieses Benutzers
lesen — sondern wird aus der Kommandozeile des Containers gelesen, also aus
derselben Quelle, die die Detailseite ohnehin anzeigt.

**Autostart** wird nie übernommen: dass ein Container gerade läuft, sagt nichts
darüber, ob du ihn nach einem Reboot zurück haben willst.

RPC-Worker haben keine Profil-Einstellungen; dort fehlt der Knopf.

## Autostart

Rootless-Container kommen beim Boot **nicht** von selbst zurück. Statt
`podman-restart.service` zu aktivieren (was zu Doppelstarts führt), gleicht die
App 15 Sekunden nach ihrem eigenen Start alle Profile mit `autostart` ab:

- Container läuft → nichts tun
- Container existiert, gestoppt → starten
- Container fehlt → neu anlegen

Nacheinander mit 5 Sekunden Abstand, weil zwei gleichzeitig ladende große
Modelle den Unified Memory zerlegen. Das Ergebnis steht auf der Übersichtsseite;
ein fehlgeschlagener Autostart ist also nicht still.

## Self-Update

Die Updates-Seite zeigt neue Commits des getrackten Branches und wendet sie an:
`git pull --ff-only` → ggf. `npm ci` → ggf. `npm run build` → Dienst neu starten.

Bei lokalen Änderungen wird das Update **abgelehnt** — auf der Box wird an den
Skripten gearbeitet, und ein Update darf das nicht überfahren.

Der Updater läuft über `systemd-run` in einer eigenen transienten Unit (mit
`--user`, wenn der Dienst als User-Unit läuft). Ein normales Kind läge in der
cgroup unseres Dienstes und würde vom abschließenden `systemctl restart` mitten
im `npm ci` erschlagen. Die Betriebsart reicht die Unit über
`SHX_SYSTEMD_SCOPE` durch.

## Entwicklung

Ohne podman, ohne GPU, auf einem beliebigen Rechner:

```bash
npm install
npm run dev      # API auf 8420 (Mock), Vite auf 5173, Zugang admin/devdev
```

Der Mock-Modus ist ein Konfigurationstausch, kein Code-Zweig: jeder externe
Prozess läuft über `server/src/lib/exec.js`, und `dev/bin/podman` bzw.
`dev/bin/hf` sind echte ausführbare Attrappen, die aufgezeichnete Ausgaben
abspielen — inklusive Carriage-Return-Fortschritt und wachsender
`.incomplete`-Dateien. Damit werden die echten Streaming- und Parser-Pfade
getestet, nicht Umgehungen davon.

```bash
npm test           # Unit-Tests (node --test)
npm run test:parity  # Argv-Vergleich gegen run-llama-server.sh
npm run lint
npm run build
```

Beide Zweige der fa/mmap-Erkennung lassen sich umschalten:

```bash
SHX_MOCK_HELP_VARIANT=old npm run dev
```

## Aufbau

```
webui/
  server/src/
    auth/      scrypt-Passwörter, JWT, Middleware
    config/    XDG-Pfade, zod-Schemata, atomarer JSON-Store
    lib/       exec (Subprozesse), sse, jobs, ansi, redact, ringbuffer
    podman/    argv, labels, features, client, servers, logstream, autostart
    models/    scan, paths (Traversal-Schutz), estimator, hfapi, download
    images/    catalog, registry, pullparse, service
    system/    amdgpu, host, network, firewall, monitor
    updates/   git, apply
    routes/    die REST-API
  web/src/     React + Vite
  shared/      Konstanten, Quant-Gruppierung, RPC-Peers, Firewall-Regeln
  dev/         Mock-Attrappen, Fixtures, Parity-Harness
  scripts/     self-update.sh, smoke.sh, shx-passwd
```

Bewusst **keine nativen npm-Module**. `npm ci` muss auf der Box nach jedem
Node-Upgrade durchlaufen — sonst wäre ausgerechnet das Self-Update die
Bruchstelle. Deshalb scrypt statt bcrypt und JSON-Dateien statt SQLite.
