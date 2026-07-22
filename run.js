/*-------------------------------------------------------------------------
| SAE - one-click launcher
|
| Preloads a Kickstart ROM and a floppy from files/ and boots them.
| AROS is a Kickstart *replacement* and additionally needs an extended
| ROM (which the stock example.htm has no slot for); real Kickstart ROMs
| do not. This launcher handles both.
|
| Not emulator-code. Uses the same public API as example.js.
-------------------------------------------------------------------------*/

var sae = null;   /* SAE instance */
var cfg = null;   /* config-object */
var running = false;

/* Selectable ROMs, all expected in files/. An "ext" means it is the AROS
   kickstart-replacement and needs that extended ROM loaded alongside. */
var ROM_OPTIONS = [
	{ key: "aros",  label: "AROS (open source)", file: "files/aros-amiga-m68k-rom.bin", ext: "files/aros-amiga-m68k-ext.bin" },
	{ key: "ks13",  label: "Kickstart 1.3",      file: "files/Kickstart 1.3.rom" },
	{ key: "ks205", label: "Kickstart 2.0.5",    file: "files/Kickstart 2.0.5.rom" },
	{ key: "ks31",  label: "Kickstart 3.1",      file: "files/Kickstart 3.1.rom" }
];
var FLOPPY = "files/Sqrxz.adf";

var buffers = {}; /* url -> Uint8Array, filled on page-load */

/*-----------------------------------------------------------------------*/

function log(msg) {
	var e = document.getElementById("log");
	e.textContent += msg + "\n";
	e.scrollTop = e.scrollHeight;
	console.log("[run] " + msg);
}

function basename(p) {
	return p.split("/").pop();
}

function query(name) {
	var m = new RegExp("[?&]" + name + "(=([^&]*))?").exec(location.search);
	return m ? (m[2] === undefined ? "" : decodeURIComponent(m[2])) : null;
}

function fetchBin(url) {
	return fetch(url).then(function (r) {
		if (!r.ok) throw new Error("HTTP " + r.status + " while fetching " + url);
		return r.arrayBuffer();
	}).then(function (buf) {
		return new Uint8Array(buf);
	});
}

/* Fill a SAEO_Config_File. SAE accepts a Uint8Array directly for .data
   (see SAEF_ZFile_fopen_file in utils.js); crc32 is optional. */
function setFile(fileObj, name, data) {
	fileObj.name = name;
	fileObj.data = data;
	fileObj.size = data.length;
	fileObj.crc32 = false;
	fileObj.prot = false;
}

function selectedRom() {
	var v = document.getElementById("cfg_rom").value;
	for (var i = 0; i < ROM_OPTIONS.length; i++)
		if (ROM_OPTIONS[i].key === v) return ROM_OPTIONS[i];
	return ROM_OPTIONS[0];
}

/*-----------------------------------------------------------------------*/

function modelConst() {
	switch (document.getElementById("cfg_model").value) {
		case "A500":  return SAEC_Model_A500;
		case "A500P": return SAEC_Model_A500P;
		case "A600":  return SAEC_Model_A600;
		case "A1200": return SAEC_Model_A1200;
		case "A2000": return SAEC_Model_A2000;
		default:      return SAEC_Model_A500;
	}
}

function start() {
	if (running) return;

	var rom = selectedRom();
	var isAros = !!rom.ext;

	if (!buffers[rom.file]) { log("ROM not loaded: " + rom.file); return; }
	if (isAros && !buffers[rom.ext]) { log("extended ROM not loaded: " + rom.ext); return; }

	/* Model defaults. buildin_default_prefs leaves ROMs/floppies alone,
	   so we set the media right after. */
	sae.setModel(modelConst(), 0);

	if (isAros) {
		/* AROS needs real fast-RAM to boot; the official app gives 4MB. */
		cfg.memory.z2FastSize = 4 << 20;
	}
	/* Many games rely on sprite/playfield collision detection. */
	cfg.chipset.colLevel = SAEC_Config_Chipset_ColLevel_Sprite_Playfield;

	/* ROM (+ extended ROM only for AROS) */
	setFile(cfg.memory.rom, basename(rom.file), buffers[rom.file]);
	if (isAros)
		setFile(cfg.memory.extRom, basename(rom.ext), buffers[rom.ext]);
	else
		cfg.memory.extRom.clr();

	/* Floppy in DF0 */
	setFile(cfg.floppy.drive[0].file, basename(FLOPPY), buffers[FLOPPY]);
	cfg.floppy.speed = SAEC_Config_Floppy_Speed_Turbo;

	cfg.video.id = "myVideo";
	/* ?canvas forces the 2D-Canvas renderer instead of the WebGL default. */
	if (query("canvas") !== null)
		cfg.video.api = SAEC_Config_Video_API_Canvas;

	cfg.hook.log.error = function (err, msg) {
		running = false;
		if (msg && msg.length) log("ERROR: " + msg);
	};

	var err = sae.start();
	if (err === SAEE_None) {
		running = true;
		log("Started: " + rom.label + " on " + document.getElementById("cfg_model").value + ". Booting...");
	} else {
		log("start() failed, code " + err);
	}
}

function stop() {
	if (!running) return;
	sae.stop();
	running = false;
	log("Stopped.");
}

function reset() {
	if (!running) return;
	sae.reset(false, false);
	log("Reset.");
}

/*-----------------------------------------------------------------------*/

function setSelectByQuery(id, param) {
	var q = query(param);
	if (!q) return;
	var sel = document.getElementById(id);
	for (var i = 0; i < sel.options.length; i++)
		if (sel.options[i].value.toUpperCase() === q.toUpperCase()) sel.selectedIndex = i;
}

function init() {
	sae = new ScriptedAmigaEmulator();
	cfg = sae.getConfig();

	/* Populate the ROM dropdown */
	var romSel = document.getElementById("cfg_rom");
	ROM_OPTIONS.forEach(function (o) {
		var opt = document.createElement("option");
		opt.value = o.key;
		opt.textContent = o.label;
		romSel.appendChild(opt);
	});

	/* URL overrides: ?rom=aros|ks13|ks205|ks31  ?model=A500|A500P|A600|A1200|A2000 */
	setSelectByQuery("cfg_rom", "rom");
	setSelectByQuery("cfg_model", "model");

	/* Fetch every file once. Individual failures just disable that ROM. */
	log("Loading files...");
	var urls = [FLOPPY];
	ROM_OPTIONS.forEach(function (o) { urls.push(o.file); if (o.ext) urls.push(o.ext); });

	Promise.all(urls.map(function (u) {
		return fetchBin(u).then(function (d) {
			buffers[u] = d;
			log("  ok   " + u + "  (" + d.length + " bytes)");
		}).catch(function (e) {
			log("  MISS " + u + "  (" + e.message + ")");
		});
	})).then(function () {
		if (!buffers[FLOPPY])
			log("WARNING: floppy missing - " + FLOPPY);
		log("Ready. Pick a ROM/model and click Start.");
		document.getElementById("btnStart").disabled = false;
	});
}
