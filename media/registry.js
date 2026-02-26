/* ================================================================
 * BC Artifacts Explorer — Webview Script (external file)
 *
 * Loaded as an external <script src="..."> so VS Code's CSP is
 * satisfied via webview.cspSource — no nonces needed.
 *
 * Receives data PUSHED by the extension and renders it.
 * Sends user-action messages back via vscode.postMessage().
 * ================================================================ */

// @ts-nocheck — this runs inside the webview, not Node.js
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /* -- State --------------------------------------------------- */
  let currentType    = "sandbox";
  let currentCountry = "";
  let loadedVersions = [];
  let totalCount     = 0;
  let currentOffset  = 0;
  let hasMore        = false;
  let loadingMore    = false;
  let allCountries   = [];
  let sortCol        = "major";
  let sortAsc        = false;

  /* -- Elements ------------------------------------------------ */
  const searchInput   = document.getElementById("searchInput");
  const countrySelect = document.getElementById("countrySelect");
  const majorSelect   = document.getElementById("majorSelect");
  const statusText    = document.getElementById("statusText");
  const promptState   = document.getElementById("promptState");
  const loadingState  = document.getElementById("loadingState");
  const errorState    = document.getElementById("errorState");
  const errorText     = document.getElementById("errorText");
  const dataTable     = document.getElementById("dataTable");
  const tableBody     = document.getElementById("tableBody");
  const tableWrapper  = document.getElementById("tableWrapper");

  /* -- Signal ready to extension ------------------------------- */
  vscode.postMessage({ command: "ready" });

  /* -- Tab switching ------------------------------------------- */
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      if (tab.dataset.type === currentType) { return; }
      document.querySelectorAll(".tab").forEach(function (t) {
        t.classList.remove("active");
      });
      tab.classList.add("active");
      currentType = tab.dataset.type;
      resetState();
      showLoading();
      vscode.postMessage({
        command: "loadCountry",
        type: currentType,
        country: countrySelect.value || undefined,
      });
    });
  });

  /* -- Country change ------------------------------------------ */
  countrySelect.addEventListener("change", function () {
    if (!countrySelect.value) { return; }
    currentCountry = countrySelect.value;
    resetState();
    showLoading();
    vscode.postMessage({
      command: "loadCountry",
      type: currentType,
      country: countrySelect.value,
    });
  });

  /* -- Search / filter ----------------------------------------- */
  searchInput.addEventListener("input", renderTable);
  majorSelect.addEventListener("change", renderTable);

  /* -- Infinite scroll ----------------------------------------- */
  tableWrapper.addEventListener("scroll", function () {
    if (!hasMore || loadingMore) { return; }
    if (tableWrapper.scrollTop + tableWrapper.clientHeight >= tableWrapper.scrollHeight - 200) {
      loadingMore = true;
      statusText.textContent = "Loading more\u2026";
      vscode.postMessage({
        command: "loadMore",
        type: currentType,
        country: currentCountry,
        offset: currentOffset,
      });
    }
  });

  /* -- Sorting ------------------------------------------------- */
  document.querySelectorAll("th[data-sort]").forEach(function (th) {
    th.addEventListener("click", function () {
      var col = th.dataset.sort;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = (col === "version" || col === "country" || col === "type");
      }
      updateSortIcons();
      renderTable();
    });
  });

  /* -- Message handler (data pushed by extension) -------------- */
  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    switch (msg.command) {

      case "countries":
        allCountries = msg.countries;
        populateCountryDropdown(msg.countries);
        showPrompt();
        break;

      case "versions":
        loadedVersions = msg.versions;
        totalCount     = msg.totalCount;
        currentOffset  = msg.offset;
        hasMore        = msg.hasMore;
        currentCountry = msg.country;
        loadingMore    = false;
        if (countrySelect.value !== msg.country) {
          countrySelect.value = msg.country;
        }
        populateMajorDropdown();
        showTable();
        renderTable();
        break;

      case "moreVersions":
        loadedVersions = loadedVersions.concat(msg.versions);
        totalCount     = msg.totalCount;
        currentOffset  = msg.offset;
        hasMore        = msg.hasMore;
        loadingMore    = false;
        populateMajorDropdown();
        renderTable();
        break;

      case "fullDataReady":
        totalCount = msg.totalCount;
        hasMore    = currentOffset < totalCount;
        renderTable();
        break;

      case "error":
        showError(msg.message);
        break;
    }
  });

  /* -- Helpers ------------------------------------------------- */

  function resetState() {
    loadedVersions = [];
    totalCount     = 0;
    currentOffset  = 0;
    hasMore        = false;
    loadingMore    = false;
    searchInput.value = "";
  }

  function renderTable() {
    var search      = searchInput.value.toLowerCase();
    var majorFilter = majorSelect.value;

    var filtered = loadedVersions.filter(function (v) {
      if (majorFilter !== "all" && String(v.major) !== majorFilter) { return false; }
      if (search) {
        var hay = (v.version + " " + v.country + " " + v.major).toLowerCase();
        if (!hay.includes(search)) { return false; }
      }
      return true;
    });

    filtered.sort(function (a, b) {
      var cmp = 0;
      switch (sortCol) {
        case "type":    cmp = a.type.localeCompare(b.type); break;
        case "major":   cmp = a.major - b.major; break;
        case "version": cmp = a.version.localeCompare(b.version, undefined, { numeric: true }); break;
        case "country": cmp = a.country.localeCompare(b.country); break;
        case "date":    cmp = (a.creationTime || "").localeCompare(b.creationTime || ""); break;
      }
      return sortAsc ? cmp : -cmp;
    });

    statusText.textContent =
      filtered.length + " shown \u00b7 " +
      loadedVersions.length + " of " + totalCount + " loaded" +
      (hasMore ? " \u00b7 scroll for more" : "");

    tableBody.innerHTML = filtered.map(function (v) {
      var date  = v.creationTime ? new Date(v.creationTime).toLocaleDateString() : "\u2014";
      var badge = v.type === "sandbox" ? "badge-sandbox" : "badge-onprem";
      var label = v.type === "sandbox" ? "Sandbox" : "OnPrem";
      return "<tr>" +
        '<td class="col-type"><span class="badge ' + badge + '">' + label + "</span></td>" +
        '<td class="col-major">' + v.major + "</td>" +
        '<td class="col-version">' + v.version + "</td>" +
        '<td class="col-country">' + v.country.toUpperCase() + "</td>" +
        '<td class="col-date">' + date + "</td>" +
        '<td class="col-actions">' +
          '<button class="btn btn-create" data-action="create"' +
            ' data-type="' + escAttr(v.type) + '"' +
            ' data-version="' + escAttr(v.version) + '"' +
            ' data-country="' + escAttr(v.country) + '"' +
            ' data-url="' + escAttr(v.artifactUrl) + '"' +
            ' title="Create a Docker container with this artifact">' +
            "\u25B6 Create" +
          "</button>" +
          '<button class="btn btn-primary" data-action="copyUrl"' +
            ' data-url="' + escAttr(v.artifactUrl) + '"' +
            ' title="Copy artifact URL to clipboard">' +
            "\uD83D\uDD17 URL" +
          "</button>" +
          '<button class="btn" data-action="copyVer"' +
            ' data-ver="' + escAttr(v.version) + '"' +
            ' title="Copy version string to clipboard">' +
            "\uD83D\uDCCB Ver" +
          "</button>" +
        "</td></tr>";
    }).join("");
  }

  function escAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
  }

  /* Delegate click events from table buttons */
  tableBody.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) { return; }
    var action = btn.dataset.action;
    if (action === "copyUrl") {
      vscode.postMessage({ command: "copyUrl", url: btn.dataset.url });
    } else if (action === "copyVer") {
      vscode.postMessage({ command: "copyVersion", version: btn.dataset.ver });
    } else if (action === "create") {
      vscode.postMessage({
        command: "createContainer",
        type: btn.dataset.type,
        version: btn.dataset.version,
        country: btn.dataset.country,
        artifactUrl: btn.dataset.url,
      });
    }
  });

  function populateCountryDropdown(countries) {
    countrySelect.innerHTML = "";
    countries.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c;
      o.textContent = c.toUpperCase();
      countrySelect.appendChild(o);
    });
  }

  function populateMajorDropdown() {
    var prev   = majorSelect.value;
    var seen   = {};
    var majors = [];
    loadedVersions.forEach(function (v) {
      if (!seen[v.major]) { seen[v.major] = true; majors.push(v.major); }
    });
    majors.sort(function (a, b) { return b - a; });

    majorSelect.innerHTML = '<option value="all">All</option>';
    majors.forEach(function (m) {
      var o = document.createElement("option");
      o.value = String(m);
      o.textContent = "BC " + m;
      majorSelect.appendChild(o);
    });
    var options = majorSelect.querySelectorAll("option");
    for (var i = 0; i < options.length; i++) {
      if (options[i].value === prev) { majorSelect.value = prev; break; }
    }
  }

  function updateSortIcons() {
    document.querySelectorAll("th[data-sort]").forEach(function (th) {
      var icon = th.querySelector(".sort-icon");
      icon.textContent = th.dataset.sort === sortCol
        ? (sortAsc ? "\u2191" : "\u2193") : "";
    });
  }

  function showPrompt() {
    promptState.style.display  = "flex";
    loadingState.style.display = "none";
    errorState.style.display   = "none";
    dataTable.style.display    = "none";
  }

  function showLoading() {
    promptState.style.display  = "none";
    loadingState.style.display = "flex";
    errorState.style.display   = "none";
    dataTable.style.display    = "none";
  }

  function showTable() {
    promptState.style.display  = "none";
    loadingState.style.display = "none";
    errorState.style.display   = "none";
    dataTable.style.display    = "table";
  }

  function showError(msg) {
    promptState.style.display  = "none";
    loadingState.style.display = "none";
    errorState.style.display   = "flex";
    errorText.textContent      = "Error: " + msg;
    dataTable.style.display    = "none";
  }

})();
