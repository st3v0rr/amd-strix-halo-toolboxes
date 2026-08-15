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

### Download bleibt bei 0 % stehen

Mit gesetztem Token lädt `huggingface_hub` über **Xet**, und dieser Weg bleibt
in manchen Netzen ohne Fehlermeldung hängen — auch auf der Konsole, unabhängig
von dieser Anwendung. Zwei Wege aus der Sackgasse, beide unter
**Einstellungen → Hugging Face**:

- **Xet-Übertragung deaktivieren** — erzwingt einfaches HTTPS
  (`HF_HUB_DISABLE_XET=1`). Der Token bleibt nutzbar, gated Repositories also
  weiterhin erreichbar. Das ist meist die bessere Wahl.
- **Token entfernen** — öffentliche Repos laden dann wieder ohne Xet.

## Firewall

Fedora bringt firewalld mit, und dessen Standardzonen lassen keinen der hier
relevanten Ports durch. Je nachdem, was auf der Maschine läuft, sind es bis zu
drei:

| Port | Wofür | Geschützt durch |
|---|---|---|
| 8420 | das Webinterface selbst | Passwort + JWT-Cookie |
| 11434 | llama-server (Default je Server) | `--api-key` |
| 50052 | RPC-Worker (`ggml-rpc-server`) | **nichts** |

Für das Webinterface erledigt das der Installer mit `--open-firewall`. Von Hand,
zusammen mit dem llama-server-Port:

```bash
sudo firewall-cmd --permanent --add-port=8420/tcp
sudo firewall-cmd --permanent --add-port=11434/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports
```

Ein zweiter Server auf einem anderen Port braucht dessen Port zusätzlich —
11435, 11436 und so weiter.

Nach einem `firewall-cmd --reload` kann podman seine eigenen
Weiterleitungsregeln verlieren. Ist ein Container danach nicht mehr erreichbar,
obwohl er läuft, hilft ein Neustart des Containers.

### Der RPC-Port ist ein Sonderfall

`ggml-rpc-server` kennt **keine Authentifizierung** — llama.cpp warnt beim Start
selbst in Großbuchstaben davor. Wer Port 50052 erreicht, kann auf der GPU dieser
Maschine rechnen lassen und ihren Speicher belegen. Deshalb nicht pauschal
aufmachen, sondern nur für die Adressen, die ihn wirklich brauchen, also den
Master des Clusters:

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
Angezeigt werden nur konfigurierte Adressen — die automatischen (`fe80::`,
`169.254.`) liegen auf jedem eingesteckten Kabel und würden nur vortäuschen,
dass zwei Maschinen sich erreichen. Die Liste ist nirgends fest verdrahtet:

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

Container werden mit `shx.*`-Labels markiert. Damit erkennt die App ihre
eigenen wieder — auch nach einem Reboot oder einem gelöschten `state.json` —
und lässt von Hand gestartete Container in Ruhe.

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
    system/    amdgpu, host, network, monitor
    updates/   git, apply
    routes/    die REST-API
  web/src/     React + Vite
  dev/         Mock-Attrappen, Fixtures, Parity-Harness
  scripts/     self-update.sh, smoke.sh, shx-passwd
```

Bewusst **keine nativen npm-Module**. `npm ci` muss auf der Box nach jedem
Node-Upgrade durchlaufen — sonst wäre ausgerechnet das Self-Update die
Bruchstelle. Deshalb scrypt statt bcrypt und JSON-Dateien statt SQLite.
