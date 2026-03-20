export function createModalFactory(options = {}) {
  const {
    introSeenKey = "introSeen",
    defaultSupportUrl = "",
  } = options;

  function markIntroSeen() {
    try {
      localStorage.setItem(introSeenKey, "true");
    } catch {
      // Ignore storage failures (private mode or quota limits).
    }
  }

  function isIntroSeen() {
    try {
      return localStorage.getItem(introSeenKey) === "true";
    } catch {
      return false;
    }
  }

  function hideIntroModal(overlay) {
    if (!overlay) return;
    overlay.style.display = "none";
    markIntroSeen();
  }

  function hideGenericModal(overlay) {
    if (!overlay) return;
    overlay.style.display = "none";
  }

  function setupSupportLink(linkEl) {
    if (!linkEl) return;

    const configuredSupportUrl = String(window.BRANCH_ROUTES_SUPPORT_URL || defaultSupportUrl || "").trim();
    if (configuredSupportUrl) {
      linkEl.href = configuredSupportUrl;
      return;
    }

    linkEl.href = "#";
    linkEl.addEventListener("click", (event) => event.preventDefault());
  }

  function createWelcomeModalDom() {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div id="intro-modal-overlay">
        <div id="intro-modal-content">
          <span id="close-modal-x">×</span>
          <h2>Branch Routes Finder</h2>
          <img src="global/banner_intro.png" alt="Map Introduction Banner">
          <ul class="intro-points">
            <li>Find and sort from <strong>closest to furthest</strong> locations.</li>
            <li>Visualize real road distances and travel times.</li>
            <li>Pick points directly on the map or type an address.</li>
          </ul>
          <button id="modal-next-btn">Next</button>
        </div>
      </div>
    `;

    const overlay = wrapper.firstElementChild;
    if (!overlay) return null;
    document.body.appendChild(overlay);

    const closeX = overlay.querySelector("#close-modal-x");
    const nextBtn = overlay.querySelector("#modal-next-btn");
    const supportLink = overlay.querySelector("#intro-support-link");
    setupSupportLink(supportLink);

    closeX?.addEventListener("click", () => hideIntroModal(overlay));
    nextBtn?.addEventListener("click", () => hideIntroModal(overlay));

    return overlay;
  }

  function showWelcomeModal(force = false) {
    if (!force && isIntroSeen()) return;

    let overlay = document.getElementById("intro-modal-overlay");
    if (!overlay) {
      overlay = createWelcomeModalDom();
      if (!overlay) return;
    }

    overlay.style.display = "flex";
  }

  function createAboutModalDom() {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div id="about-modal-overlay" class="app-modal-overlay">
        <div id="about-modal-content" class="app-modal-content">
          <div class="about-modal-header">
            <span id="close-about-modal-x" class="modal-close-x">×</span>
            <h2>About Branch Routes</h2>
          </div>
          <div class="about-modal-body">
            <p><strong>"I got tired of searching over and over for multiple destinations, so I automated it":</strong> Manually searching destinations one by one, memorizing distances, and comparing routes in your head is busywork. It is slow, error-prone, and a total drain.</p>
            <p><strong>What do you mean?</strong><br>
              Let's see this simple example then you will know<br>
              <strong>Me:</strong> I need to go to cafe A but now they have literally 10 braanches in the city. Which one is closest to me?<br>
              <strong>Others map:</strong> Manually search for each branch address, check the distance, and remember it. Repeat for all 10 branches. Then compare which one is closest before you forget it<br>
              <strong>This map:</strong> Just throw that damn 10 branches list in, hit calculate, and boom - ranked results with real road distances and travel times. No more mental gymnastics, just instant clarity.</p>
            <p><strong>The "Lazy" Solution:</strong> Branch Routes is built for the moment you just want to paste your branch list, hit calculate, and get ranked results instantly. No complex setup. No hand-tracking. No "near enough" guesses pretending to be precise coordinates.</p>
            <p><strong>The Reliability (Legend):</strong> <strong>RED / PHOTON</strong> means direct database hit: the point exists and is verified. <strong>ORANGE / GEOMATH</strong> is the secret sauce: when the map has a gap, the engine applies <strong>Inward-Out Hierarchical Logic</strong> plus <strong>Linear Interpolation</strong> to compute the coordinate between verified anchors. It prevents map teleporting to distant alleys just because a house number is missing.</p>
            <p><strong>The Tech (No Bloat):</strong> Directly to solve problems, no <strong>"I installed this library then I don't use it"</strong>. Data handles provider retrieval and normalization. <strong>App</strong> handles resolution logic and coordinate computation. <strong>Presentation</strong> handles map UX and explainable output. Stack: <strong>Vanilla JS</strong>, <strong>Leaflet</strong>, and <strong>OSRM</strong>.</p>
            <p><strong>Disclaimer:</strong><br>
              - Eventhough I tried my best to optimize own engine library, the error and location inaccuracy still can happen due to the complexity of geocoding and routing problem. I will try my best to check any possible cases and update the engine to make it better.<br>
              - For more information, if possible check simple Q&A in the button right below or reach out to me via email. I am open to feedback, suggestions, and any form of constructive criticism to make this tool more useful for everyone.
            </p>
          </div>
          <div class="about-modal-footer">
            <a id="about-support-link" class="intro-support-link" href="#" target="_blank" rel="noopener noreferrer">Like the idea? Buy me a cup of coffee!</a>
          </div>
        </div>
      </div>
    `;

    const overlay = wrapper.firstElementChild;
    if (!overlay) return null;
    document.body.appendChild(overlay);

    const closeX = overlay.querySelector("#close-about-modal-x");
    const supportLink = overlay.querySelector("#about-support-link");
    setupSupportLink(supportLink);

    closeX?.addEventListener("click", () => hideGenericModal(overlay));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) hideGenericModal(overlay);
    });

    return overlay;
  }

  function showAboutModal() {
    let overlay = document.getElementById("about-modal-overlay");
    if (!overlay) {
      overlay = createAboutModalDom();
      if (!overlay) return;
    }

    overlay.style.display = "flex";
  }

  function createQAModalDom() {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div id="qa-modal-overlay" class="app-modal-overlay">
        <div id="qa-modal-content" class="app-modal-content">
          <div class="about-modal-header">
            <span id="close-qa-modal-x" class="modal-close-x">×</span>
            <h2>QA - Welp, I need help</h2>
            <p style="text-align: center;">
              No problem, here are some questions that "you are not the first one to ask literally"
            </p>
          </div>
          <div class="about-modal-body">
            <p><strong>"What is this project for?"</strong><br> 
              Read again in info icon right above
            </p>
            <p><strong>"The location seems to be not accuracy when I have complex addresses"</strong><br>
              Uhhh, I know, this is hard problem in geocoding and routing when using something open-source data. I will try my best to optimize the engine to make it better.<br>
              But in the meantime, here are some tips to understand how the engine works and why it can be more reliable than "close enough" geocoding results:<br>
              - Try best to use PHOTON, it use database contributed by many people and have accuracy better than others. If your target location close to any location in PHOTON search, use that<br>
              - Don't overcomplex the address, try to keep it with housenumber, street, ward and city/country. Thats all<br>
            </p>
            <p><strong>"I see location mark has different colors, what is that mean?"</strong><br> 
              - Well, as I mention above, locations not always exist in the map database, and when that happen, the engine will try to apply some logic to find the best guess location. <br>  
                - <strong>RED</strong> means the location is directly found in PHOTON database, so it is verified and more likely to be accurate.<br>
                - <strong>ORANGE</strong> means the location is not directly found, but the engine can find some anchors around it and apply interpolation to estimate the location. So it is less likely to be accurate than RED, but still can be more reliable than random guess.<br>
                - <strong>GREY</strong> means the location is found by fuzzy search, so it is the least likely to be accurate, but still can be useful when you have no better option. <br>
              - When you see <strong>ORANGE</strong> or <strong>GREY</strong>, try to verify the location by checking the address and context, or try to drag the marker to the correct location if you know it. <br>
            </p>
            <p><strong>"Wait, what? Draggable in OpenStreetMap!?"</strong><br>
              "..."<br>
              "..."<br>
              <strong>"If it doesn't exist then make it so I make it"</strong>. It just more than draggable. By acting as a point, you now can use it to add stop in your route, and the engine will treat it as a verified point and apply interpolation logic to find other points around it. So it can be a powerful way to improve the accuracy of the engine when you have some knowledge about the location but it is not directly found in the database. <br>
            </p>
            <p><strong>"Will you steal my data?"</strong><br>
              Tsk, I don't need to do that, your location already exist on gg map literally so you still think its secret? Literally you are using the map now.
            </p>
            <p><strong>"Can the web automatic detect my location right after I enter?"</strong><br>
              Tsk, literally just click "Use My Location" button.
            </p>
          </div>
          <div class="about-modal-footer">
            <a id="qa-support-link" class="intro-support-link" href="#" target="_blank" rel="noopener noreferrer">Still can't find what you're looking for? Get in touch!</a>
          </div>
        </div>
      </div>
    `;

    const overlay = wrapper.firstElementChild;
    if (!overlay) return null;
    document.body.appendChild(overlay);

    const closeX = overlay.querySelector("#close-qa-modal-x");
    const supportLink = overlay.querySelector("#qa-support-link");
    setupSupportLink(supportLink);

    closeX?.addEventListener("click", () => hideGenericModal(overlay));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) hideGenericModal(overlay);
    });

    return overlay;
  }

  function showQAModal() {
    let overlay = document.getElementById("qa-modal-overlay");
    if (!overlay) {
      overlay = createQAModalDom();
      if (!overlay) return;
    }

    overlay.style.display = "flex";
  }

  function createCreditModalDom() {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div id="credit-modal-overlay" class="app-modal-overlay">
        <div id="credit-modal-content" class="app-modal-content">
          <div class="about-modal-header">
            <span id="close-credit-modal-x" class="modal-close-x">×</span>
            <h2>Credits</h2>
          </div>
          <div class="about-modal-body">
          <p><strong>Thank you to all open-source contributors and data providers:</strong><br>
            - <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> for the amazing map data and community<br>
            - <a href="https://github.com/omniscale/photon" target="_blank" rel="noopener noreferrer">Photon</a> for the geocoding search over OpenStreetMap data<br>
            - <a href="https://github.com/Project-OSRM/osrm-backend" target="_blank" rel="noopener noreferrer">OSRM</a> for the real-road routing and travel distance/time computation<br>
            - <a href="https://leafletjs.com/" target="_blank" rel="noopener noreferrer">Leaflet</a> for the interactive map rendering<br>
            - All the individual contributors who have added data to OpenStreetMap, making projects like this possible<br>
          </p>
          <p><strong>And of course, thank you for using this tool! I hope it makes your life easier and saves you time. If you have any feedback or suggestions, please don't hesitate to reach out.</strong></p>
          </div>
        </div>
      </div>
    `;

    const overlay = wrapper.firstElementChild;
    if (!overlay) return null;
    document.body.appendChild(overlay);

    const closeX = overlay.querySelector("#close-credit-modal-x");
    const supportLink = overlay.querySelector("#credit-support-link");
    setupSupportLink(supportLink);

    closeX?.addEventListener("click", () => hideGenericModal(overlay));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) hideGenericModal(overlay);
    });

    return overlay;
  }

  function showCreditModal() {
    let overlay = document.getElementById("credit-modal-overlay");
    if (!overlay) {
      overlay = createCreditModalDom();
      if (!overlay) return;
    }

    overlay.style.display = "flex";
  }

  function ensureFloatingActionTriggers() {
    let container = document.getElementById("map-controls-wrapper");
    if (!container) {
      container = document.createElement("div");
      container.id = "map-controls-wrapper";
      container.className = "map-controls-wrapper";
      document.body.appendChild(container);
    }

    let helpTrigger = document.getElementById("welcome-help-trigger");
    if (!helpTrigger) {
      helpTrigger = document.createElement("button");
      helpTrigger.id = "welcome-help-trigger";
      helpTrigger.type = "button";
      helpTrigger.setAttribute("aria-label", "Open welcome help");
      helpTrigger.innerHTML = '<i class="fa-solid fa-circle-question" aria-hidden="true"></i>';
      container.appendChild(helpTrigger);
    }

    let infoTrigger = document.getElementById("about-info-trigger");
    if (!infoTrigger) {
      infoTrigger = document.createElement("button");
      infoTrigger.id = "about-info-trigger";
      infoTrigger.type = "button";
      infoTrigger.setAttribute("aria-label", "Open about project details");
      infoTrigger.innerHTML = '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>';
      container.appendChild(infoTrigger);
    }

    let qaTrigger = document.getElementById("qa-action-trigger");
    if (!qaTrigger) {
      qaTrigger = document.createElement("button");
      qaTrigger.id = "qa-action-trigger";
      qaTrigger.type = "button";
      qaTrigger.setAttribute("aria-label", "Open QA modal");
      qaTrigger.innerHTML = '<i class="fa-regular fa-comment-dots" aria-hidden="true"></i>';
      container.appendChild(qaTrigger);
    }

    let creditTrigger = document.getElementById("credit-action-trigger");
    if (!creditTrigger) {
      creditTrigger = document.createElement("button");
      creditTrigger.id = "credit-action-trigger";
      creditTrigger.type = "button";
      creditTrigger.setAttribute("aria-label", "Open credits modal");
      creditTrigger.innerHTML = '<i class="fa-solid fa-scroll" aria-hidden="true"></i>';
      container.appendChild(creditTrigger);
    }

    helpTrigger.onclick = () => showWelcomeModal(true);
    infoTrigger.onclick = () => showAboutModal();
    qaTrigger.onclick = () => showQAModal();
    creditTrigger.onclick = () => showCreditModal();
  }

  function initIntroductionModal() {
    ensureFloatingActionTriggers();
    showWelcomeModal(false);
  }

  return {
    hideIntroModal,
    hideGenericModal,
    createWelcomeModalDom,
    showWelcomeModal,
    createAboutModalDom,
    showAboutModal,
    createQAModalDom,
    showQAModal,
    createCreditModalDom,
    showCreditModal,
    ensureFloatingActionTriggers,
    initIntroductionModal,
  };
}
