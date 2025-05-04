
const { St, Gio, GLib, Clutter, GObject } = imports.gi;
const Main = imports.ui.main;

function getBatteryPath() {
    let upowerPaths = GLib.spawn_command_line_sync('upower -e')[1]
        .toString()
        .trim()
        .split('\n');
    return upowerPaths.find(p => p.includes('battery_')) || null;
}

let BATTERY_PATH = getBatteryPath();

function getAsciiBar(percent) {
    const filled = Math.floor(percent / 10);
    let bar = '';
    for (let i = 0; i < 10; i++) {
        bar += (i < filled) ? '█' : '░';
    }
    return `${bar} ${percent}%`;
}

function getVolumeVisual(percent) {
    const bars = ['▁','▂','▃','▄','▅','▆','▇','█'];
    let level = Math.floor(percent / 12.5);
    level = Math.min(level, 7);
    let volBar = bars.slice(0, level + 1).join('');
    return volBar.padEnd(8, ' ');
}

function getBrightnessPercentAsync(callback) {
    try {
        let [success1, currentBytes] = GLib.file_get_contents('/sys/class/backlight/intel_backlight/brightness');
        let [success2, maxBytes] = GLib.file_get_contents('/sys/class/backlight/intel_backlight/max_brightness');

        if (!success1 || !success2) {
            log('Brillo error: no se pudo leer uno de los archivos');
            return callback(null);
        }

        let current = parseInt(currentBytes.toString().trim());
        let max = parseInt(maxBytes.toString().trim());

        if (isNaN(current) || isNaN(max) || max === 0) {
            log(`Brillo inválido: current=${current}, max=${max}`);
            return callback(null);
        }

        let percent = Math.round((current / max) * 100);
        log(`Brillo OK: ${current}/${max} = ${percent}%`);
        callback(percent);
    } catch (e) {
        logError(e);
        callback(null);
    }
}

function getBrightnessVisual(percent) {
    const stages = ['○','◔','◑','◕','⬤'];
    let index = Math.floor(percent / 25);
    index = Math.min(index, stages.length - 1);
    return stages[index];
}

function getVolumePercentAsync(callback) {
    let proc = new Gio.Subprocess({
        argv: ['pactl', 'get-sink-volume', '@DEFAULT_SINK@'],
        flags: Gio.SubprocessFlags.STDOUT_PIPE
    });

    proc.init(null);
    proc.communicate_utf8_async(null, null, (proc, res) => {
        try {
            let [, stdout] = proc.communicate_utf8_finish(res);
            let match = stdout.match(/(\d+)%/);
            callback(match ? parseInt(match[1]) : null);
        } catch {
            callback(null);
        }
    });
}

function getWifiStatusAsync(callback) {
    let proc = new Gio.Subprocess({
        argv: ['nmcli', '-t', '-f', 'active,ssid,signal', 'dev', 'wifi'],
        flags: Gio.SubprocessFlags.STDOUT_PIPE
    });

    proc.init(null);
    proc.communicate_utf8_async(null, null, (proc, res) => {
        try {
            let [, stdout] = proc.communicate_utf8_finish(res);
            let lines = stdout.trim().split('\n');
            let activeLine = lines.find(line => line.startsWith("yes:"));
            if (!activeLine) return callback('📡 No link');

            let parts = activeLine.split(":");
            let ssid = parts[1];
            let signal = parseInt(parts[2] || "0");

            const signalBlocks = ['▁','▄','▆','█'];
            let signalLevel = Math.min(Math.floor(signal / 25), 3);
            let bar = signalBlocks.slice(0, signalLevel + 1).join('');
            callback(`WiFi ${bar} ${ssid}`);
        } catch {
            callback('📶 Error');
        }
    });
}

let batteryProxy = null;
let asciiLabel = null;
let timeoutId = null;

function init() {}

function enable() {
    Gio.Settings.new('org.gnome.desktop.interface').set_string('color-scheme', 'prefer-dark');
    const menu = Main.panel.statusArea.aggregateMenu;
    if (!menu) return;

    Gio.DBusProxy.new(
        Gio.DBus.system,
        Gio.DBusProxyFlags.NONE,
        null,
        'org.freedesktop.UPower',
        BATTERY_PATH,
        'org.freedesktop.UPower.Device',
        null,
        (proxy, result) => {
            batteryProxy = Gio.DBusProxy.new_finish(result);
        }
    );

    menu.remove_all_children();

    asciiLabel = new St.Label({
        text: 'Loading...',
        y_align: Clutter.ActorAlign.CENTER,
        style: 'color: #00cccc; font-family: "Noto Sans Symbols", "DejaVu Sans Mono", "Ubuntu Mono", monospace; font-size: 12px; padding-left: 6px; padding-right: 6px;'
    });

    menu.add_child(asciiLabel);

    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
        updateAsciiIndicator();
        return true;
    });
}

function updateAsciiIndicator() {
    if (!asciiLabel) return;

    let battery = batteryProxy
        ? Math.floor(batteryProxy.get_cached_property('Percentage').unpack())
        : null;

    let state = batteryProxy && batteryProxy.get_cached_property('State')
        ? batteryProxy.get_cached_property('State').unpack()
        : 0;

    getBrightnessPercentAsync(brightness => {
        getVolumePercentAsync(volume => {
            getWifiStatusAsync(wifi => {
                if (volume === null) volume = 0;
                let brightnessVisual = brightness !== null ? getBrightnessVisual(brightness) : '??';
                let volumeBar = getVolumeVisual(volume);

                // Construir la línea sin batería si no hay
                let parts = [
                    `VOL ${volumeBar}`,
                    `BRI ${brightnessVisual}`,
                    wifi
                ];

                if (battery !== null) {
                    let batteryBar = getAsciiBar(battery);
                    parts.push(`BAT ${batteryBar}`);
                }

                // Estilo depende del estado de la batería, o gris si no hay
                let color = battery === null
                    ? "#cccccc"
                    : (state === 1 ? "#44ff44" : (battery < 20 ? "#ff4444" : "#00cccc"));

                asciiLabel.set_style(`color: ${color}; font-family: monospace; font-size: 12px; padding-left: 6px; padding-right: 6px;`);
                asciiLabel.set_text(parts.join('  '));
            });
        });
    });
}

function disable() {
    const menu = Main.panel.statusArea.aggregateMenu;
    if (!menu || !asciiLabel) return;

    if (timeoutId) GLib.source_remove(timeoutId);
    timeoutId = null;

    asciiLabel.destroy();
    asciiLabel = null;

}
