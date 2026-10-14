/** Build the voice control independently of its connection backend. */
export function createVoiceControl({ reset = false } = {}) {
  let root = document.getElementById('gev-voice-control');
  let providerField = document.getElementById('gev-voice-provider-field');
  if (root && reset) {
    root.remove();
    providerField?.remove();
    root = null;
    providerField = null;
  }
  if (!root) {
    providerField = document.createElement('div');
    providerField.id = 'gev-voice-provider-field';
    providerField.className = 'gev-voice-provider-field';
    providerField.setAttribute('data-panel-surface', '');
    providerField.hidden = true;
    providerField.innerHTML = `
      <div data-panel-header class="gev-voice-provider-header">
        <span class="panel-surface-title">VOICE</span>
      </div>
      <div data-panel-body class="gev-voice-provider-controls">
        <select id="gev-voice-provider" class="panel-surface-control" aria-label="Voice provider" title="Changing provider reconnects voice if it is on">
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
        </select>
        <button id="gev-voice-settings-button" class="panel-surface-control gev-voice-settings-button" type="button" aria-label="Voice settings" title="Voice settings" aria-expanded="false" aria-controls="gev-voice-panel">
          <span class="material-symbols-outlined gev-voice-settings-icon" aria-hidden="true">settings</span>
          <span class="gev-voice-settings-label" aria-hidden="true">VOICE SETTINGS</span>
        </button>
      </div>
    `;
    root = document.createElement('div');
    root.id = 'gev-voice-control';
    root.dataset.status = 'idle';
    root.dataset.speaker = 'idle';
    root.innerHTML = `
      <div class="gev-voice-heading">
        <div class="gev-voice-kicker">AI AGENT</div>
        <div id="gev-voice-status">OFF</div>
      </div>
      <button id="gev-voice-button" type="button" aria-label="Voice control — activate to toggle voice; hold Space to speak" aria-describedby="gev-voice-help">
        <span class="gev-mic-orbit"><img src="/mic.svg" alt="" /></span>
        <span class="gev-mic-label">ON/OFF</span>
      </button>
      <div class="gev-voice-visualizer" aria-hidden="true">
        ${Array.from({ length: 15 }, (_, index) => `<span style="--bar:${index}"></span>`).join('')}
      </div>
      <div class="gev-voice-readout">
        <div id="gev-voice-detail">VOICE STANDBY</div>
      </div>
      <div id="gev-voice-help" class="gev-voice-help-tray" role="tooltip">
        <span class="gev-voice-help-kicker">VOICE CONTROL</span>
        <span class="gev-voice-help-detail">Hold Space to speak · tap Space to activate focused controls</span>
      </div>
      <section id="gev-voice-panel" class="gev-voice-panel" data-panel-popup hidden aria-label="Voice">
        <div class="gev-voice-panel-header" data-panel-header>
          <span class="panel-surface-title">VOICE</span>
          <div class="gev-voice-panel-tabs" role="tablist" aria-label="Voice panel">
            <button id="gev-voice-preview-tab" class="panel-surface-control gev-voice-panel-tab" type="button" role="tab" aria-label="Voice Preview" title="Voice Preview" aria-selected="true" aria-controls="gev-voice-preview-panel" tabindex="0"><span class="material-symbols-outlined gev-voice-panel-tab-icon" aria-hidden="true">visibility</span></button>
            <button id="gev-voice-settings-tab" class="panel-surface-control gev-voice-panel-tab" type="button" role="tab" aria-label="Voice Settings" title="Voice Settings" aria-selected="false" aria-controls="gev-voice-settings-panel" tabindex="-1"><span class="material-symbols-outlined gev-voice-panel-tab-icon" aria-hidden="true">settings</span></button>
          </div>
          <button id="gev-voice-settings-close" class="panel-surface-control gev-voice-panel-close" type="button" aria-label="Close voice panel" title="Close voice panel">×</button>
        </div>
        <section id="gev-voice-preview-panel" class="gev-voice-panel-content" role="tabpanel" aria-labelledby="gev-voice-preview-tab" tabindex="0">
          <section id="gev-voice-card" class="gev-voice-card" hidden aria-label="Voice assistant">
            <div class="gev-voice-card-header">
              <span id="gev-voice-card-phase" class="gev-voice-card-phase"></span>
            </div>
            <p id="gev-voice-card-user" class="gev-voice-card-caption" data-role="user" hidden><span class="gev-voice-card-who">YOU</span><span id="gev-voice-card-user-text" class="gev-voice-card-text"></span></p>
            <p id="gev-voice-card-pointer" class="gev-voice-card-pointer" hidden><span id="gev-voice-card-pointer-kind" class="gev-voice-card-who">THIS</span><span class="gev-voice-card-sr">: </span><span id="gev-voice-card-pointer-text" class="gev-voice-card-pointer-label"></span></p>
            <p id="gev-voice-card-assistant" class="gev-voice-card-caption" data-role="assistant" hidden><span class="gev-voice-card-who">GEV</span><span id="gev-voice-card-assistant-text" class="gev-voice-card-text"></span></p>
            <ol id="gev-voice-card-plan" class="gev-voice-card-plan" aria-label="Plan" hidden></ol>
            <div id="gev-voice-card-result" class="gev-voice-card-result" hidden>
              <div id="gev-voice-card-result-title" class="gev-voice-card-result-title"></div>
              <div id="gev-voice-card-chips" class="gev-voice-card-chips" hidden></div>
              <ul id="gev-voice-card-lines" class="gev-voice-card-lines"></ul>
              <ol id="gev-voice-card-referents" class="gev-voice-card-referents" aria-label="Referenced items" hidden></ol>
              <details id="gev-voice-card-notes" class="gev-voice-card-notes" hidden>
                <summary>NOTES &amp; SOURCES</summary>
                <ul id="gev-voice-card-note-list" class="gev-voice-card-lines"></ul>
              </details>
            </div>
            <div id="gev-voice-card-live" class="gev-voice-card-sr" aria-live="polite" aria-atomic="true"></div>
          </section>
          <p id="gev-voice-preview-empty" class="gev-voice-preview-empty">Your voice conversation will appear here.</p>
        </section>
        <section id="gev-voice-settings-panel" class="gev-voice-settings-panel gev-voice-panel-content" role="tabpanel" aria-labelledby="gev-voice-settings-tab" tabindex="0" hidden>
          <div data-panel-body>
            <label class="gev-voice-preview-setting" for="gev-voice-preview">
              <span><strong>Voice preview</strong><small id="gev-voice-preview-note">Show captions and results. Voice stays on when hidden.</small></span>
              <input id="gev-voice-preview" type="checkbox" checked aria-describedby="gev-voice-preview-note" />
            </label>
            <fieldset class="gev-voice-inactivity-fieldset" aria-describedby="gev-voice-inactivity-note gev-voice-provider-limit-note">
              <legend>INACTIVITY TIMEOUT</legend>
              <div class="gev-voice-inactivity-chips">
                <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="3" /><span>3 min</span></label>
                <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="5" /><span>5 min</span></label>
                <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="10" /><span>10 min</span></label>
                <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="15" /><span>15 min</span></label>
                <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="custom" /><span>Custom</span></label>
                <label class="gev-voice-inactivity-chip"><input type="radio" name="gev-voice-inactivity" value="none" /><span>None</span></label>
              </div>
            </fieldset>
            <label class="gev-voice-inactivity-custom" for="gev-voice-inactivity-custom" hidden>
              <span class="gev-voice-inactivity-custom-heading">
                <span>CUSTOM DURATION</span>
                <output id="gev-voice-inactivity-custom-value" for="gev-voice-inactivity-custom">5 min</output>
              </span>
              <input class="gev-quantitative-slider" id="gev-voice-inactivity-custom" type="range" min="1" max="60" step="1" value="5" aria-describedby="gev-voice-inactivity-note gev-voice-provider-limit-note" />
              <span class="gev-voice-inactivity-range-scale" aria-hidden="true"><span>1 min</span><span>60 min</span></span>
            </label>
            <p id="gev-voice-inactivity-note" class="gev-voice-settings-note" aria-live="polite"></p>
            <section class="gev-voice-cost-settings" aria-label="OpenAI session settings" hidden>
              <div class="gev-voice-settings-section-title">OPENAI SESSION</div>
              <div class="gev-voice-cost-setting-row">
                <span><strong>MODEL TIER</strong><small>Applies next session</small></span>
                <button id="gev-voice-tier" class="panel-surface-control gev-voice-tier-btn" type="button" aria-pressed="false" title="Voice model tier — applies next session">STD</button>
              </div>
              <div class="gev-voice-cost-setting-row">
                <span><strong>ESTIMATED COST</strong><small>Current session</small></span>
                <output id="gev-voice-cost-value" class="gev-voice-cost-value" data-level="ok" title="Estimated session cost">~$0.00</output>
              </div>
            </section>
            <p id="gev-voice-provider-limit-note" class="gev-voice-settings-note gev-voice-provider-limit-note"></p>
          </div>
        </section>
      </section>
      <div class="gev-voice-error-tray" role="alert" aria-live="assertive">
        <div class="gev-voice-error-header">
          <span>VOICE SYSTEM ERROR</span>
          <button class="gev-voice-error-dismiss" type="button">DISMISS</button>
        </div>
        <div id="gev-voice-error-detail"></div>
        <div class="gev-voice-error-hint">Check microphone permission and network access, then try again.</div>
      </div>
    `;
    const commandDock = document.getElementById('command-dock');
    if (commandDock) {
      const locationBar = document.getElementById('location-bar');
      const controlPanel = document.getElementById('control-panel');
      commandDock.appendChild(providerField);
      commandDock.appendChild(root);
      if (locationBar) commandDock.insertBefore(locationBar, root);
      if (controlPanel) commandDock.appendChild(controlPanel);
    } else {
      document.body.appendChild(providerField);
      document.body.appendChild(root);
    }
    root
      .querySelector('.gev-voice-error-dismiss')
      ?.addEventListener('click', () => {
        root.classList.add('error-dismissed');
      });
  }
  return {
    root,
    providerField,
    providerSelect: providerField?.querySelector('#gev-voice-provider'),
    voiceSettingsButton: providerField?.querySelector(
      '#gev-voice-settings-button',
    ),
    voiceSettingsPanel: root.querySelector('#gev-voice-settings-panel'),
    voiceSettingsClose: root.querySelector('#gev-voice-settings-close'),
    voicePreviewInput: root.querySelector('#gev-voice-preview'),
    inactivityOptions: root.querySelectorAll(
      'input[name="gev-voice-inactivity"]',
    ),
    inactivityCustomRow: root.querySelector('.gev-voice-inactivity-custom'),
    inactivityCustomInput: root.querySelector('#gev-voice-inactivity-custom'),
    inactivityCustomValue: root.querySelector(
      '#gev-voice-inactivity-custom-value',
    ),
    inactivityNote: root.querySelector('#gev-voice-inactivity-note'),
    providerLimitNote: root.querySelector('#gev-voice-provider-limit-note'),
    button: root.querySelector('#gev-voice-button'),
    buttonLabel: root.querySelector('.gev-mic-label'),
    status: root.querySelector('#gev-voice-status'),
    detail: root.querySelector('#gev-voice-detail'),
    helpDetail: root.querySelector('.gev-voice-help-detail'),
    errorDetail: root.querySelector('#gev-voice-error-detail'),
    errorHint: root.querySelector('.gev-voice-error-hint'),
    errorTray: root.querySelector('.gev-voice-error-tray'),
    costSettings: root.querySelector('.gev-voice-cost-settings'),
    tierButton: root.querySelector('#gev-voice-tier'),
    costValue: root.querySelector('#gev-voice-cost-value'),
    voicePanel: root.querySelector('#gev-voice-panel'),
    previewPanel: root.querySelector('#gev-voice-preview-panel'),
    previewTab: root.querySelector('#gev-voice-preview-tab'),
    settingsTab: root.querySelector('#gev-voice-settings-tab'),
    previewEmpty: root.querySelector('#gev-voice-preview-empty'),
    card: root.querySelector('#gev-voice-card'),
  };
}
