/* =========================================================
   Gestión Agrícola — app.js
   Lógica de cálculo, conexión a Supabase y gráficos.
   ========================================================= */

/* ---------------------------------------------------------
   1) CONFIGURACIÓN DE SUPABASE
   Pegá acá tus dos datos del panel de Supabase
   (Settings -> API). NO uses la clave "secret", solo la
   publishable. Es seguro que la publishable quede en el código.
   --------------------------------------------------------- */
const SUPABASE_URL = "PEGÁ_TU_URL_ACÁ";          // ej: https://xxxxx.supabase.co
const SUPABASE_KEY = "PEGÁ_TU_KEY_ACÁ";          // ej: sb_publishable_xxxxx

/* --------------------------------------------------------- */

const CROP = {
  Soja:    { color: "#639922", bg: "#EAF3DE", text: "#27500A" },
  "Maíz":  { color: "#EF9F27", bg: "#FAEEDA", text: "#633806" },
  Trigo:   { color: "#BA7517", bg: "#FAEEDA", text: "#412402" },
  Cebada:  { color: "#97C459", bg: "#EAF3DE", text: "#27500A" },
  Avena:   { color: "#378ADD", bg: "#E6F1FB", text: "#0C447C" },
  Girasol: { color: "#D85A30", bg: "#FAECE7", text: "#4A1B0C" }
};

const COL = {
  green: "#639922", greenDark: "#3B6D11", amber: "#BA7517",
  red: "#E24B4A", blue: "#378ADD", soil: "#888780", teal: "#0F6E56"
};

const App = (() => {
  let sb = null;            // cliente supabase
  let lotes = [];           // cache local de lotes
  let charts = {};          // instancias de Chart.js
  let online = false;

  const $ = (id) => document.getElementById(id);
  const num = (id) => parseFloat($(id).value) || 0;
  const str = (id) => $(id).value;
  const fmt = (v) => Math.round(v).toLocaleString("es-AR");
  const fmt2 = (v) => v.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ===================== MOTOR DE CÁLCULO ===================== */

  // Calcula resultados proyectados a partir de los inputs crudos de un lote
  function computeProjected(d) {
    const pct = (d.participacion || 0) / 100;
    const ha = d.hectareas || 0;
    const ins = d.insumos || 0;
    const lab = d.labores || 0;
    const precioEsp = d.precio_esperado || 0;
    const commPct = (d.gastos_comerciales_pct || 0) / 100;

    let rentUsd = 0, rentPct = 0;
    if (d.tipo_alquiler === "fixed") rentUsd = d.alquiler_fijo || 0;
    else if (d.tipo_alquiler === "qq") rentUsd = (d.alquiler_qq || 0) * (d.alquiler_precio_soja || 0) * 0.1;
    else rentPct = (d.alquiler_pct || 0) / 100;

    const precioNeto = precioEsp * (1 - commPct);
    let indHa = 0, costoTotal = 0;
    if (d.tipo_alquiler === "pct") {
      const base = ins + lab;
      indHa = precioNeto > 0 ? (base / (precioNeto * (1 - rentPct))) * 1000 : 0;
      costoTotal = base + (indHa / 1000) * precioNeto * rentPct;
    } else {
      costoTotal = ins + lab + rentUsd;
      indHa = precioNeto > 0 ? (costoTotal / precioNeto) * 1000 : 0;
    }
    const rentFinal = d.tipo_alquiler === "pct" ? (indHa / 1000) * precioNeto * rentPct : rentUsd;

    return {
      pct, ha, ins, lab, rentFinal, precioNeto,
      costoTotal, indHa, indTot: indHa * ha,
      costoNetHa: costoTotal * pct,
      invTotal: costoTotal * pct * ha
    };
  }

  // Calcula resultados de cierre (requiere rinde_real y precio_real)
  function computeClose(d) {
    const rinde = d.rinde_real || 0;
    const precio = d.precio_real || 0;
    if (!rinde || !precio) return null;

    const pct = (d.participacion || 0) / 100;
    const ha = d.hectareas || 0;
    const ingBruto = (rinde / 1000) * precio;

    let gc = 0;
    if (d.gc_tipo_real === "pct") gc = ingBruto * ((d.gc_valor_real || 0) / 100);
    else if (d.gc_tipo_real === "usd") gc = d.gc_valor_real || 0;
    else gc = (d.gc_valor_real || 0) / (d.tipo_cambio_ars || 1);

    let rentUsd = 0;
    if (d.tipo_alquiler === "fixed") rentUsd = d.alquiler_fijo || 0;
    else if (d.tipo_alquiler === "qq") rentUsd = (d.alquiler_qq || 0) * (d.alquiler_precio_soja || 0) * 0.1;
    else rentUsd = ingBruto * ((d.alquiler_pct || 0) / 100);

    const costoTotal = (d.insumos || 0) + (d.labores || 0) + rentUsd;
    const ingresoNeto = ingBruto - gc;
    const margenHa = ingresoNeto - costoTotal;
    const precioNetoReal = rinde > 0 ? ingresoNeto / (rinde / 1000) : 0;

    let indRealHa = 0;
    if (d.tipo_alquiler === "pct") {
      const base = (d.insumos || 0) + (d.labores || 0);
      indRealHa = precioNetoReal > 0 ? (base / (precioNetoReal * (1 - (d.alquiler_pct || 0) / 100))) * 1000 : 0;
    } else {
      indRealHa = precioNetoReal > 0 ? (costoTotal / precioNetoReal) * 1000 : 0;
    }

    return {
      ingBruto, gc, rentUsd, costoTotal, ingresoNeto,
      margenHa, margenHaNet: margenHa * pct,
      ingresoNetHaNet: ingresoNeto * pct,
      costoNetHa: costoTotal * pct,
      indRealHa, indRealTot: indRealHa * ha,
      excedente: rinde - indRealHa,
      rindeTot: rinde * ha
    };
  }

  /* ===================== SUPABASE ===================== */

  async function initSupabase() {
    const badConfig = SUPABASE_URL.includes("PEGÁ") || SUPABASE_KEY.includes("PEGÁ");
    if (badConfig || !window.supabase) {
      setConn("off", "Sin conexión");
      online = false;
      return;
    }
    try {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      await loadLotes();
      setConn("ok", "Conectado");
      online = true;
    } catch (e) {
      console.error("Error conectando a Supabase:", e);
      setConn("off", "Sin conexión");
      online = false;
    }
  }

  function setConn(state, label) {
    const el = $("conn-status");
    el.className = "conn-status conn-" + state;
    const icon = state === "ok" ? "ti-cloud-check"
      : state === "off" ? "ti-cloud-off" : "ti-loader-2 spin";
    el.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i> ${label}`;
  }

  async function loadLotes() {
    if (!sb) return;
    const { data, error } = await sb.from("lotes").select("*").order("creado", { ascending: false });
    if (error) { console.error(error); return; }
    lotes = data || [];
    $("lote-count").textContent = lotes.length;
  }

  /* ===================== NAVEGACIÓN ===================== */

  function switchTab(name) {
    ["nuevo", "lotes", "resumen", "simulador"].forEach((t) => {
      $("panel-" + t).classList.toggle("is-active", t === name);
      $("tab-" + t).classList.toggle("is-active", t === name);
    });
    if (name === "lotes") renderLotes();
    if (name === "resumen") renderResumen();
    if (name === "simulador") calcSim();
  }

  /* ===================== PESTAÑA NUEVO LOTE ===================== */

  function readForm() {
    return {
      nombre: str("n-nombre").trim() || "Lote sin nombre",
      cereal: str("n-cereal"),
      campana: str("n-campana") || str("campaign"),
      hectareas: num("n-hectareas"),
      participacion: num("n-participacion"),
      insumos: num("n-insumos"),
      labores: num("n-labores"),
      tipo_alquiler: str("n-tipo-alquiler"),
      alquiler_fijo: num("n-alq-fijo"),
      alquiler_qq: num("n-alq-qq"),
      alquiler_precio_soja: num("n-alq-soja"),
      alquiler_pct: num("n-alq-pct"),
      precio_esperado: num("n-precio-esp"),
      gastos_comerciales_pct: num("n-gc-pct"),
      rinde_real: num("n-rinde-real") || null,
      precio_real: num("n-precio-real") || null,
      gc_tipo_real: str("n-gc-tipo"),
      gc_valor_real: num("n-gc-valor"),
      tipo_cambio_ars: num("n-tc-ars"),
      cerrado: !!(num("n-rinde-real") && num("n-precio-real"))
    };
  }

  function refreshRentInputs() {
    const t = str("n-tipo-alquiler");
    $("rent-fixed").hidden = t !== "fixed";
    $("rent-qq").hidden = t !== "qq";
    $("rent-pct").hidden = t !== "pct";
    calcForm();
  }

  function refreshGcInputs() {
    const t = str("n-gc-tipo");
    const labels = { pct: "Gastos comerciales (%)", usd: "Gastos comerciales (USD/Ha)", ars: "Gastos comerciales (ARS/Ha)" };
    $("n-gc-label").textContent = labels[t];
    $("ars-row").hidden = t !== "ars";
    calcForm();
  }

  function calcForm() {
    const d = readForm();
    const p = computeProjected(d);

    $("r-pct").textContent = d.participacion;
    $("r-ind-ha-cnt").textContent = d.hectareas;
    $("r-ind-ha").textContent = fmt(p.indHa) + " Kg/Ha";
    $("r-ind-tot").textContent = fmt(p.indTot) + " Kg";
    $("r-costo").textContent = "USD " + fmt2(p.costoNetHa);
    $("r-precio").textContent = "USD " + fmt2(p.precioNeto);
    $("r-inv").textContent = "USD " + fmt(p.invTotal);

    drawComposition(p.ins * p.pct, p.lab * p.pct, p.rentFinal * p.pct);

    const cl = computeClose(d);
    if (!cl) { $("cierre-preview").hidden = true; return; }
    $("cierre-preview").hidden = false;
    $("r-rreal-ha").textContent = fmt(d.rinde_real) + " Kg/Ha";
    $("r-rreal-tot").textContent = fmt(cl.rindeTot) + " Kg";
    $("r-indr-ha").textContent = fmt(cl.indRealHa) + " Kg/Ha";
    $("r-indr-tot").textContent = fmt(cl.indRealTot) + " Kg";
    setSigned($("r-exc"), cl.excedente, fmt(cl.excedente) + " Kg", true);
    setSigned($("r-margen"), cl.margenHaNet, "USD " + fmt2(cl.margenHaNet), false);
  }

  function setSigned(el, value, text, kg) {
    el.textContent = (value >= 0 ? (kg ? "+" : "") : "") + text;
    el.className = "metric-value " + (value >= 0 ? "pos" : "neg");
  }

  function clearForm() {
    $("n-nombre").value = "";
    $("n-rinde-real").value = "";
    $("n-precio-real").value = "";
    calcForm();
  }

  async function saveLote() {
    const d = readForm();
    const btn = $("btn-guardar");
    if (!online || !sb) {
      showToast("nuevo", "err", "No hay conexión con la base. Revisá la configuración de Supabase en app.js.");
      return;
    }
    btn.disabled = true;
    const { error } = await sb.from("lotes").insert([d]);
    btn.disabled = false;
    if (error) {
      console.error(error);
      showToast("nuevo", "err", "No se pudo guardar: " + error.message);
      return;
    }
    await loadLotes();
    showToast("nuevo", "ok", `Lote "${d.nombre}" (${d.cereal}, ${d.hectareas} Ha) guardado` + (d.cerrado ? " con cierre." : "."));
    clearForm();
  }

  function showToast(panel, kind, msg) {
    const el = $("toast-" + panel);
    el.className = "toast toast-" + kind;
    const icon = kind === "ok" ? "ti-check" : "ti-alert-triangle";
    el.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i> ${msg}`;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, 5000);
  }

  /* ===================== PESTAÑA MIS LOTES ===================== */

  function cropPill(c) {
    const s = CROP[c] || { bg: "#F1EFE8", text: "#2C2C2A" };
    return `<span class="crop-pill" style="background:${s.bg};color:${s.text}">${c}</span>`;
  }
  function signedCell(v, prefix, dec) {
    if (v === null || v === undefined) return `<span class="val-muted">—</span>`;
    const cls = v >= 0 ? "val-pos" : "val-neg";
    const body = (v < 0 ? "-" : "") + prefix + Math.abs(v).toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return `<span class="${cls}">${body}</span>`;
  }
  function kgCell(v) {
    if (v === null || v === undefined) return `<span class="val-muted">—</span>`;
    return fmt(v) + " Kg";
  }

  function renderLotes() {
    const camp = str("campaign");
    const fCrop = str("f-cereal");
    const fEstado = str("f-estado");
    $("lotes-camp").textContent = camp;

    let rows = lotes.filter((l) => l.campana === camp);
    if (fCrop) rows = rows.filter((l) => l.cereal === fCrop);
    if (fEstado === "abierto") rows = rows.filter((l) => !l.cerrado);
    if (fEstado === "cerrado") rows = rows.filter((l) => l.cerrado);

    const body = $("lotes-body");
    const empty = $("lotes-empty");

    if (!rows.length) {
      body.innerHTML = "";
      empty.hidden = false;
      ["s-ha", "s-inv", "s-ing", "s-res"].forEach((id) => { $(id).textContent = "—"; $(id).className = "metric-value"; });
      return;
    }
    empty.hidden = true;

    body.innerHTML = rows.map((l) => {
      const p = computeProjected(l);
      const cl = computeClose(l);
      const margenHa = cl ? cl.margenHaNet : null;
      const margenTot = cl ? cl.margenHaNet * l.hectareas : null;
      return `<tr>
        <td class="cell-name">${escapeHtml(l.nombre)}</td>
        <td>${cropPill(l.cereal)}</td>
        <td class="num">${l.hectareas}</td>
        <td class="num">${l.participacion}%</td>
        <td class="num">USD ${fmt(p.costoNetHa)}</td>
        <td class="num val-accent">${fmt(p.indHa)} Kg</td>
        <td class="num val-accent">${fmt(p.indTot)} Kg</td>
        <td class="num">${cl ? kgCell(l.rinde_real) : '<span class="val-muted">—</span>'}</td>
        <td class="num">${cl ? kgCell(cl.rindeTot) : '<span class="val-muted">—</span>'}</td>
        <td class="num">${signedCell(margenHa, "USD ", 2)}</td>
        <td class="num">${signedCell(margenTot, "USD ", 0)}</td>
        <td>${l.cerrado ? '<span class="badge badge-closed">Cerrado</span>' : '<span class="badge badge-open">Abierto</span>'}</td>
        <td><button class="btn btn-danger" onclick="App.deleteLote(${l.id})" aria-label="Eliminar lote"><i class="ti ti-trash" aria-hidden="true"></i></button></td>
      </tr>`;
    }).join("");

    let sHa = 0, sInv = 0, sIng = 0, sRes = 0, hasClosed = false;
    rows.forEach((l) => {
      const p = computeProjected(l);
      sHa += l.hectareas;
      sInv += p.costoNetHa * l.hectareas;
      const cl = computeClose(l);
      if (cl) { sIng += cl.ingresoNetHaNet * l.hectareas; sRes += cl.margenHaNet * l.hectareas; hasClosed = true; }
    });
    $("s-ha").textContent = sHa + " Ha";
    $("s-inv").textContent = "USD " + fmt(sInv);
    $("s-ing").textContent = hasClosed ? "USD " + fmt(sIng) : "—";
    const resEl = $("s-res");
    if (hasClosed) { resEl.textContent = "USD " + fmt(sRes); resEl.className = "metric-value " + (sRes >= 0 ? "pos" : "neg"); }
    else { resEl.textContent = "—"; resEl.className = "metric-value"; }
  }

  async function deleteLote(id) {
    if (!confirm("¿Eliminar este lote? No se puede deshacer.")) return;
    if (!online || !sb) return;
    const { error } = await sb.from("lotes").delete().eq("id", id);
    if (error) { console.error(error); alert("No se pudo eliminar: " + error.message); return; }
    await loadLotes();
    renderLotes();
  }

  /* ===================== PESTAÑA RESUMEN ===================== */

  function renderResumen() {
    const camp = str("campaign");
    $("res-camp").textContent = camp;
    const data = lotes.filter((l) => l.campana === camp);

    $("res-lotes").textContent = data.length;
    $("res-ha").textContent = data.reduce((s, l) => s + l.hectareas, 0) + " Ha";
    const closed = data.filter((l) => l.cerrado);
    $("res-cerrados").textContent = closed.length;

    let net = 0;
    closed.forEach((l) => { const cl = computeClose(l); if (cl) net += cl.margenHaNet * l.hectareas; });
    const totEl = $("res-total");
    if (closed.length) { totEl.textContent = "USD " + fmt(net); totEl.className = "metric-value " + (net >= 0 ? "pos" : "neg"); }
    else { totEl.textContent = "—"; totEl.className = "metric-value"; }

    renderCultivoTable(data);
    drawWaterfall(closed);
    drawProjectedVsReal(closed);
    drawRanking(closed);
    drawHaByCrop(data);
  }

  function renderCultivoTable(data) {
    const crops = {};
    data.forEach((l) => {
      if (!crops[l.cereal]) crops[l.cereal] = { n: 0, ha: 0, inv: 0, ing: 0, res: 0, indSum: 0, rindeSum: 0, nClosed: 0 };
      const c = crops[l.cereal];
      const p = computeProjected(l);
      c.n++; c.ha += l.hectareas; c.inv += p.costoNetHa * l.hectareas; c.indSum += p.indHa;
      const cl = computeClose(l);
      if (cl) { c.ing += cl.ingresoNetHaNet * l.hectareas; c.res += cl.margenHaNet * l.hectareas; c.rindeSum += l.rinde_real; c.nClosed++; }
    });

    const keys = Object.keys(crops);
    const body = $("cultivo-body");
    const empty = $("cultivo-empty");
    if (!keys.length) { body.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;

    body.innerHTML = keys.map((c) => {
      const d = crops[c];
      const margenHa = d.nClosed && d.ha > 0 ? d.res / d.ha : null;
      const indProm = d.n > 0 ? d.indSum / d.n : 0;
      const rindeProm = d.nClosed > 0 ? d.rindeSum / d.nClosed : null;
      return `<tr>
        <td>${cropPill(c)}</td>
        <td class="num">${d.n}</td>
        <td class="num">${d.ha} Ha</td>
        <td class="num">USD ${fmt(d.inv)}</td>
        <td class="num">${d.nClosed ? "USD " + fmt(d.ing) : '<span class="val-muted">—</span>'}</td>
        <td class="num">${d.nClosed ? signedCell(d.res, "USD ", 0) : '<span class="val-muted">—</span>'}</td>
        <td class="num">${margenHa !== null ? signedCell(margenHa, "USD ", 2) : '<span class="val-muted">—</span>'}</td>
        <td class="num val-accent">${fmt(indProm)} Kg/Ha</td>
        <td class="num">${rindeProm !== null ? '<span class="val-pos">' + fmt(rindeProm) + " Kg/Ha</span>" : '<span class="val-muted">—</span>'}</td>
        <td>${d.nClosed ? '<span class="badge badge-closed">Con datos</span>' : '<span class="badge badge-open">Proyectado</span>'}</td>
      </tr>`;
    }).join("");
  }

  /* ===================== GRÁFICOS ===================== */

  function destroy(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

  const baseOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } }
  };
  function axisColor() { return "#888780"; }
  function gridColor() { return "rgba(136,135,128,0.14)"; }

  // (1) Composición de costos — dona
  function drawComposition(ins, lab, alq) {
    const total = ins + lab + alq;
    const vals = [ins, lab, alq];
    const labels = ["Insumos", "Labores", "Alquiler"];
    const colors = [COL.green, COL.blue, COL.amber];
    const pcts = vals.map((v) => (total > 0 ? ((v / total) * 100).toFixed(1) : "0.0"));
    $("leg-comp").innerHTML = labels.map((l, i) =>
      `<span><span class="legend-dot" style="background:${colors[i]}"></span>${l}: $${fmt(vals[i])} (${pcts[i]}%)</span>`).join("");
    destroy("comp");
    charts.comp = new Chart($("chart-comp"), {
      type: "doughnut",
      data: { labels, datasets: [{ data: vals.map((v) => +v.toFixed(2)), backgroundColor: colors, borderWidth: 2, borderColor: "#fff", hoverOffset: 4 }] },
      options: { ...baseOpts, cutout: "62%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` USD ${fmt2(c.raw)}/Ha` } } } }
    });
  }

  // (2) Cascada de rentabilidad — promedio ponderado de cerrados
  function drawWaterfall(closed) {
    destroy("waterfall");
    const ctx = $("chart-waterfall");
    if (!closed.length) { blankChart("waterfall", ctx); return; }

    let totHa = 0, ingBruto = 0, insumos = 0, labores = 0, alquiler = 0, gc = 0;
    closed.forEach((l) => {
      const cl = computeClose(l); if (!cl) return;
      const ha = l.hectareas; const pct = l.participacion / 100;
      totHa += ha;
      ingBruto += cl.ingBruto * pct * ha;
      insumos += (l.insumos || 0) * pct * ha;
      labores += (l.labores || 0) * pct * ha;
      alquiler += cl.rentUsd * pct * ha;
      gc += cl.gc * pct * ha;
    });
    if (totHa === 0) { blankChart("waterfall", ctx); return; }
    const ib = ingBruto / totHa, ins = insumos / totHa, lab = labores / totHa, alq = alquiler / totHa, g = gc / totHa;
    const margen = ib - ins - lab - alq - g;

    const labels = ["Ingreso bruto", "Insumos", "Labores", "Alquiler", "G. comerciales", "Margen neto"];
    let run = 0;
    const bases = [], spans = [], colors = [];
    // ingreso bruto
    bases.push(0); spans.push(ib); colors.push(COL.teal); run = ib;
    // restas
    [ins, lab, alq, g].forEach((v, i) => {
      bases.push(run - v); spans.push(v); colors.push(COL.red); run -= v;
    });
    // margen final
    bases.push(0); spans.push(margen); colors.push(margen >= 0 ? COL.green : COL.red);

    charts.waterfall = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets: [
        { data: bases, backgroundColor: "transparent", stack: "w" },
        { data: spans, backgroundColor: colors, borderRadius: 4, stack: "w" }
      ]},
      options: {
        ...baseOpts,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: (c) => c.datasetIndex === 1 ? ` USD ${fmt2(c.raw)}/Ha` : null
        } } },
        scales: {
          x: { ticks: { color: axisColor(), font: { size: 11 }, maxRotation: 35, minRotation: 0 }, grid: { display: false } },
          y: { stacked: true, ticks: { color: axisColor(), font: { size: 11 }, callback: (v) => "$" + fmt(v) }, grid: { color: gridColor() } },
          x2: { display: false }
        }
      }
    });
  }

  // (3) Proyectado vs real — barras agrupadas
  function drawProjectedVsReal(closed) {
    destroy("pvr");
    const ctx = $("chart-pvr");
    $("leg-pvr").innerHTML =
      `<span><span class="legend-dot" style="background:${COL.soil}"></span>Proyectado</span>` +
      `<span><span class="legend-dot" style="background:${COL.green}"></span>Real</span>`;
    if (!closed.length) { blankChart("pvr", ctx); return; }

    let n = 0, indP = 0, indR = 0, rindeP = 0, rindeR = 0;
    closed.forEach((l) => {
      const p = computeProjected(l), cl = computeClose(l); if (!cl) return;
      n++; indP += p.indHa; indR += cl.indRealHa; rindeR += l.rinde_real;
      // "rinde proyectado" = indiferencia proyectada como umbral de referencia
      rindeP += p.indHa;
    });
    if (!n) { blankChart("pvr", ctx); return; }

    charts.pvr = new Chart(ctx, {
      type: "bar",
      data: {
        labels: ["Indiferencia (Kg/Ha)", "Rinde (Kg/Ha)"],
        datasets: [
          { label: "Proyectado", data: [indP / n, rindeP / n], backgroundColor: COL.soil, borderRadius: 4 },
          { label: "Real", data: [indR / n, rindeR / n], backgroundColor: COL.green, borderRadius: 4 }
        ]
      },
      options: {
        ...baseOpts,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.raw)} Kg/Ha` } } },
        scales: {
          x: { ticks: { color: axisColor(), font: { size: 11 } }, grid: { display: false } },
          y: { ticks: { color: axisColor(), font: { size: 11 }, callback: (v) => fmt(v) }, grid: { color: gridColor() } }
        }
      }
    });
  }

  // (4) Ranking de rentabilidad — barras horizontales
  function drawRanking(closed) {
    destroy("ranking");
    const ctx = $("chart-ranking");
    if (!closed.length) { blankChart("ranking", ctx); return; }

    const items = closed.map((l) => {
      const cl = computeClose(l);
      return { nombre: l.nombre, margen: cl ? cl.margenHaNet : 0, cereal: l.cereal };
    }).sort((a, b) => b.margen - a.margen);

    charts.ranking = new Chart(ctx, {
      type: "bar",
      data: {
        labels: items.map((i) => i.nombre),
        datasets: [{
          data: items.map((i) => +i.margen.toFixed(0)),
          backgroundColor: items.map((i) => i.margen >= 0 ? (CROP[i.cereal]?.color || COL.green) : COL.red),
          borderRadius: 4
        }]
      },
      options: {
        ...baseOpts,
        indexAxis: "y",
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` USD ${fmt(c.raw)}/Ha` } } },
        scales: {
          x: { ticks: { color: axisColor(), font: { size: 11 }, callback: (v) => "$" + fmt(v) }, grid: { color: gridColor() } },
          y: { ticks: { color: axisColor(), font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
  }

  // (5) Hectáreas por cultivo — dona
  function drawHaByCrop(data) {
    destroy("haxc");
    const ctx = $("chart-haxc");
    const crops = {};
    data.forEach((l) => { crops[l.cereal] = (crops[l.cereal] || 0) + l.hectareas; });
    const keys = Object.keys(crops);
    if (!keys.length) { $("leg-haxc").innerHTML = ""; blankChart("haxc", ctx); return; }

    const colors = keys.map((c) => CROP[c]?.color || COL.soil);
    $("leg-haxc").innerHTML = keys.map((c, i) =>
      `<span><span class="legend-dot" style="background:${colors[i]}"></span>${c}: ${crops[c]} Ha</span>`).join("");

    charts.haxc = new Chart(ctx, {
      type: "doughnut",
      data: { labels: keys, datasets: [{ data: keys.map((c) => crops[c]), backgroundColor: colors, borderWidth: 2, borderColor: "#fff", hoverOffset: 4 }] },
      options: { ...baseOpts, cutout: "58%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.raw} Ha` } } } }
    });
  }

  function blankChart(key, ctx) {
    charts[key] = new Chart(ctx, {
      type: "bar",
      data: { labels: ["Sin datos cerrados"], datasets: [{ data: [0], backgroundColor: COL.soil }] },
      options: { ...baseOpts, plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { ticks: { color: axisColor(), font: { size: 11 } }, grid: { display: false } }, y: { display: false } } }
    });
  }

  /* ===================== PESTAÑA SIMULADOR ===================== */

  function readSimForm() {
    return {
      nombre: "Simulación",
      cereal: str("sim-cereal"),
      campana: str("campaign"),
      hectareas: num("sim-hectareas"),
      participacion: num("sim-participacion"),
      insumos: num("sim-insumos"),
      labores: num("sim-labores"),
      tipo_alquiler: str("sim-tipo-alquiler"),
      alquiler_fijo: num("sim-alq-fijo"),
      alquiler_qq: num("sim-alq-qq"),
      alquiler_precio_soja: num("sim-alq-soja"),
      alquiler_pct: num("sim-alq-pct"),
      precio_esperado: num("sim-precio-esp"),
      gastos_comerciales_pct: num("sim-gc-pct")
    };
  }

  function refreshSimRentInputs() {
    const t = str("sim-tipo-alquiler");
    $("sim-rent-fixed").hidden = t !== "fixed";
    $("sim-rent-qq").hidden = t !== "qq";
    $("sim-rent-pct").hidden = t !== "pct";
    calcSim();
  }

  // margen estimado a partir de rinde esperado y precio (sin escribir nada)
  function estimateMargin(d, rinde, precio) {
    const pct = d.participacion / 100;
    const ingBruto = (rinde / 1000) * precio;
    const gc = ingBruto * (d.gastos_comerciales_pct / 100);
    let rentUsd = 0;
    if (d.tipo_alquiler === "fixed") rentUsd = d.alquiler_fijo;
    else if (d.tipo_alquiler === "qq") rentUsd = d.alquiler_qq * d.alquiler_precio_soja * 0.1;
    else rentUsd = ingBruto * (d.alquiler_pct / 100);
    const costo = d.insumos + d.labores + rentUsd;
    return (ingBruto - gc - costo) * pct;
  }

  function calcSim() {
    const d = readSimForm();
    const p = computeProjected(d);
    const rinde = num("sim-rinde");
    const precio = d.precio_esperado;

    $("sim-ind-ha").textContent = fmt(p.indHa) + " Kg/Ha";
    $("sim-ind-tot").textContent = fmt(p.indTot) + " Kg";

    const margenHa = estimateMargin(d, rinde, precio);
    setSigned($("sim-margen-ha"), margenHa, "USD " + fmt2(margenHa), false);
    setSigned($("sim-margen-tot"), margenHa * d.hectareas, "USD " + fmt(margenHa * d.hectareas), false);

    drawSensitivity(d, rinde, precio);
  }

  // Sensibilidad: margen/Ha variando precio y rinde de -20% a +20%
  function drawSensitivity(d, rinde, precio) {
    destroy("sens");
    const ctx = $("chart-sens");
    const steps = [-20, -10, 0, 10, 20];
    const byPrice = steps.map((s) => estimateMargin(d, rinde, precio * (1 + s / 100)));
    const byYield = steps.map((s) => estimateMargin(d, rinde * (1 + s / 100), precio));

    $("leg-sens").innerHTML =
      `<span><span class="legend-dot" style="background:${COL.blue}"></span>Varía precio</span>` +
      `<span><span class="legend-dot" style="background:${COL.amber}"></span>Varía rinde</span>`;

    charts.sens = new Chart(ctx, {
      type: "line",
      data: {
        labels: steps.map((s) => (s > 0 ? "+" : "") + s + "%"),
        datasets: [
          { label: "Precio", data: byPrice.map((v) => +v.toFixed(0)), borderColor: COL.blue, backgroundColor: COL.blue, tension: 0.25, pointRadius: 3, borderWidth: 2 },
          { label: "Rinde", data: byYield.map((v) => +v.toFixed(0)), borderColor: COL.amber, backgroundColor: COL.amber, borderDash: [5, 4], tension: 0.25, pointRadius: 3, borderWidth: 2 }
        ]
      },
      options: {
        ...baseOpts,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: USD ${fmt(c.raw)}/Ha` } } },
        scales: {
          x: { ticks: { color: axisColor(), font: { size: 11 } }, grid: { display: false } },
          y: { ticks: { color: axisColor(), font: { size: 11 }, callback: (v) => "$" + fmt(v) }, grid: { color: gridColor() } }
        }
      }
    });
  }

  // Pasar escenario del simulador al formulario de nuevo lote
  function simToLote() {
    $("n-cereal").value = str("sim-cereal");
    $("n-hectareas").value = num("sim-hectareas");
    $("n-participacion").value = num("sim-participacion");
    $("n-insumos").value = num("sim-insumos");
    $("n-labores").value = num("sim-labores");
    $("n-tipo-alquiler").value = str("sim-tipo-alquiler");
    $("n-alq-fijo").value = num("sim-alq-fijo");
    $("n-alq-qq").value = num("sim-alq-qq");
    $("n-alq-soja").value = num("sim-alq-soja");
    $("n-alq-pct").value = num("sim-alq-pct");
    $("n-precio-esp").value = num("sim-precio-esp");
    $("n-gc-pct").value = num("sim-gc-pct");
    $("n-nombre").value = "";
    refreshRentInputs();
    switchTab("nuevo");
    showToast("nuevo", "ok", "Escenario cargado. Revisá el nombre y guardá cuando quieras.");
  }

  /* ===================== UTILIDADES ===================== */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  function bindInputs() {
    document.querySelectorAll("#panel-nuevo input, #panel-nuevo select").forEach((el) => {
      el.addEventListener("input", calcForm);
    });
    document.querySelectorAll("#panel-simulador input, #panel-simulador select").forEach((el) => {
      el.addEventListener("input", calcSim);
    });
    $("campaign").addEventListener("change", () => {
      const active = document.querySelector(".tab.is-active").id.replace("tab-", "");
      if (active === "lotes") renderLotes();
      if (active === "resumen") renderResumen();
    });
  }

  async function init() {
    bindInputs();
    refreshRentInputs();
    refreshGcInputs();
    calcForm();
    await initSupabase();
  }

  return {
    init, switchTab, refreshRentInputs, refreshGcInputs,
    clearForm, saveLote, deleteLote, renderLotes, renderResumen,
    refreshSimRentInputs, simToLote
  };
})();

document.addEventListener("DOMContentLoaded", App.init);
