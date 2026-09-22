document.addEventListener("DOMContentLoaded", () => {
    const DISMISSED_ALERTS_KEY = "campus-app-dismissed-alerts";
    const tabs = document.querySelectorAll(".tab-item");
    const views = document.querySelectorAll(".app-view");
    const mainContent = document.querySelector(".main-content");
    const dismissedAlertList = document.getElementById("dismissed-alert-list");
    const savedAlertCount = document.getElementById("saved-alert-count");
    const mapCanvas = document.querySelector(".map-canvas");
    const mapStage = document.getElementById("map-stage");
    const mapFooterText = document.getElementById("map-footer-text");
    const mapDetailCard = document.getElementById("map-detail-card");
    const weatherRefresh = document.getElementById("weather-refresh");
    const transitCards = document.querySelectorAll(".transit-card[data-route-id]");
    const transitFilters = document.querySelectorAll("[data-transit-filter]");
    const transitRefresh = document.getElementById("transit-refresh");
    const transitUpdated = document.getElementById("transit-updated");
    const transitEmpty = document.getElementById("transit-empty");
    let lastWeatherCoordinates = null;

    function loadDismissedAlerts() {
        try {
            const savedAlerts = localStorage.getItem(DISMISSED_ALERTS_KEY);
            if (!savedAlerts) return [];

            const alerts = JSON.parse(savedAlerts);
            return Array.isArray(alerts) ? alerts : [];
        } catch (error) {
            console.error("Unable to load dismissed campus alerts.", error);
            return [];
        }
    }

    function saveDismissedAlerts(alerts) {
        try {
            localStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(alerts));
        } catch (error) {
            console.error("Unable to save dismissed campus alerts.", error);
        }
    }

    function renderDismissedAlerts() {
        const alerts = loadDismissedAlerts();
        savedAlertCount.textContent = alerts.length;

        if (!alerts.length) {
            dismissedAlertList.innerHTML = '<p class="empty-alerts">Dismissed alerts will appear here.</p>';
            return;
        }

        dismissedAlertList.innerHTML = "";
        alerts.forEach(alert => {
            const item = document.createElement("article");
            item.className = "saved-alert";
            item.dataset.alertId = alert.id;

            const content = document.createElement("div");
            content.className = "saved-alert-content";

            const title = document.createElement("div");
            title.className = "saved-alert-title";
            title.textContent = alert.title;

            const meta = document.createElement("div");
            meta.className = "saved-alert-meta";
            meta.textContent = `Dismissed ${new Date(alert.dismissedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;

            const restoreButton = document.createElement("button");
            restoreButton.className = "restore-alert";
            restoreButton.type = "button";
            restoreButton.dataset.restoreAlert = alert.id;
            restoreButton.textContent = "Restore";

            content.append(title, meta);
            item.append(content, restoreButton);
            dismissedAlertList.appendChild(item);
        });
    }

    function restoreAlert(alert) {
        const card = document.createElement("div");
        card.className = "orange-card";
        card.id = "live-alert-card";
        card.dataset.alertId = alert.id;
        card.innerHTML = `
            <div class="card-badge"><span class="pulse-dot"></span> ${alert.badge}</div>
            <h3></h3>
            <p></p>
            <div class="card-actions">
                <button class="btn-dark" id="btn-detour">Show detour</button>
                <button class="btn-outline btn-dismiss-alert" type="button">Dismiss</button>
            </div>
        `;
        card.querySelector("h3").textContent = alert.title;
        card.querySelector("p").textContent = alert.description;
        dismissedAlertList.closest(".dismissed-alerts").before(card);
    }

    function dismissAlert() {
        const liveAlertCard = document.getElementById("live-alert-card");
        if (!liveAlertCard) return;
        const scrollPosition = mainContent ? mainContent.scrollTop : 0;

        const alert = {
            id: liveAlertCard.dataset.alertId,
            badge: liveAlertCard.querySelector(".card-badge").textContent.trim(),
            title: liveAlertCard.querySelector("h3").textContent,
            description: liveAlertCard.querySelector("p").textContent,
            dismissedAt: new Date().toISOString()
        };
        const alerts = loadDismissedAlerts().filter(savedAlert => savedAlert.id !== alert.id);
        alerts.unshift(alert);
        saveDismissedAlerts(alerts);

        liveAlertCard.classList.add("is-dismissing");
        window.setTimeout(() => {
            liveAlertCard.remove();
            renderDismissedAlerts();

            const weatherCodeDescriptions = {
                0: ["Clear sky", "☀️"],
                1: ["Mainly clear", "🌤️"],
                2: ["Partly cloudy", "⛅"],
                3: ["Overcast", "☁️"],
                45: ["Foggy", "🌫️"],
                48: ["Rime fog", "🌫️"],
                51: ["Light drizzle", "🌦️"],
                53: ["Drizzle", "🌦️"],
                55: ["Heavy drizzle", "🌧️"],
                61: ["Light rain", "🌦️"],
                63: ["Rain", "🌧️"],
                65: ["Heavy rain", "🌧️"],
                71: ["Light snow", "🌨️"],
                73: ["Snow", "🌨️"],
                75: ["Heavy snow", "❄️"],
                80: ["Rain showers", "🌦️"],
                81: ["Rain showers", "🌧️"],
                82: ["Heavy showers", "⛈️"],
                95: ["Thunderstorm", "⛈️"],
                96: ["Thunderstorm with hail", "⛈️"],
                99: ["Thunderstorm with hail", "⛈️"]
            };

            function setWeatherError(message) {
                document.getElementById("weather-loading").hidden = true;
                document.getElementById("current-weather-content").hidden = true;
                const error = document.getElementById("weather-error");
                error.textContent = message;
                error.hidden = false;
            }

            async function loadWeather(coordinates) {
                const weatherLocation = document.getElementById("weather-location");
                const weatherUpdated = document.getElementById("weather-updated");
                const weatherLoading = document.getElementById("weather-loading");
                const weatherError = document.getElementById("weather-error");
                weatherRefresh.disabled = true;
                weatherRefresh.textContent = "Updating weather…";
                weatherLoading.hidden = false;
                weatherError.hidden = true;

                const params = new URLSearchParams({
                    latitude: coordinates.latitude.toString(),
                    longitude: coordinates.longitude.toString(),
                    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
                    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                    forecast_days: "1",
                    timezone: "auto"
                });

                try {
                    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
                    if (!response.ok) throw new Error(`Weather service returned ${response.status}.`);
                    const data = await response.json();
                    const current = data.current;
                    const daily = data.daily;
                    const [condition, icon] = weatherCodeDescriptions[current.weather_code] || ["Current conditions", "🌡️"];

                    weatherLocation.textContent = `${coordinates.latitude.toFixed(3)}°, ${coordinates.longitude.toFixed(3)}°`;
                    weatherUpdated.textContent = `Updated ${new Date(current.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Live data`;
                    document.getElementById("current-weather-icon").textContent = icon;
                    document.getElementById("current-temperature").textContent = Math.round(current.temperature_2m);
                    document.getElementById("current-condition").textContent = condition;
                    document.getElementById("feels-like").textContent = `${Math.round(current.apparent_temperature)}°`;
                    document.getElementById("humidity").textContent = `${current.relative_humidity_2m}%`;
                    document.getElementById("wind-speed").textContent = `${Math.round(current.wind_speed_10m)} km/h`;
                    document.getElementById("rain-amount").textContent = `${current.precipitation} mm`;
                    document.getElementById("forecast-high").textContent = `${Math.round(daily.temperature_2m_max[0])}°`;
                    document.getElementById("forecast-low").textContent = `${Math.round(daily.temperature_2m_min[0])}°`;
                    document.getElementById("forecast-rain").textContent = `${daily.precipitation_probability_max[0]}%`;
                    weatherLoading.hidden = true;
                    document.getElementById("current-weather-content").hidden = false;
                    document.getElementById("weather-metrics").hidden = false;
                } catch (error) {
                    console.error("Unable to load current weather.", error);
                    setWeatherError("Live weather is temporarily unavailable. Check your connection and try again.");
                } finally {
                    weatherRefresh.disabled = false;
                    weatherRefresh.textContent = "Refresh weather";
                }
            }

            function requestWeather() {
                if (!navigator.geolocation) {
                    setWeatherError("Your browser does not support location services, so local weather cannot be loaded.");
                    return;
                }
                weatherRefresh.disabled = true;
                weatherRefresh.textContent = "Finding location…";
                document.getElementById("weather-loading").hidden = false;
                document.getElementById("current-weather-content").hidden = true;
                document.getElementById("weather-metrics").hidden = true;
                document.getElementById("weather-error").hidden = true;
                if (lastWeatherCoordinates) {
                    loadWeather(lastWeatherCoordinates);
                    return;
                }
                navigator.geolocation.getCurrentPosition(
                    position => {
                        lastWeatherCoordinates = position.coords;
                        loadWeather(lastWeatherCoordinates);
                    },
                    error => {
                        const message = error.code === error.PERMISSION_DENIED
                            ? "Location access was denied. Allow location access to see weather for your current location."
                            : "We could not determine your location. Try refreshing weather again.";
                        setWeatherError(message);
                        weatherRefresh.disabled = false;
                        weatherRefresh.textContent = "Refresh weather";
                    },
                    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
                );
            }

            if (weatherRefresh) {
                weatherRefresh.addEventListener("click", () => {
                    lastWeatherCoordinates = null;
                    requestWeather();
                });
                requestWeather();
            }
            if (mainContent) {
                mainContent.style.overflowY = "auto";
                mainContent.scrollTop = scrollPosition;
            }
        }, 300);
    }

    renderDismissedAlerts();

    let transitFilter = "all";
    function applyTransitFilter() {
        let visibleCount = 0;
        transitCards.forEach(card => {
            const visible = transitFilter === "all" || card.dataset.transitType === transitFilter;
            card.classList.toggle("filter-hidden", !visible);
            if (visible) visibleCount += 1;
        });
        transitEmpty.hidden = visibleCount > 0;
        transitUpdated.textContent = `Live arrivals · ${visibleCount} routes shown`;
    }

    transitFilters.forEach(filterButton => {
        filterButton.addEventListener("click", () => {
            transitFilter = filterButton.dataset.transitFilter;
            transitFilters.forEach(button => {
                const active = button === filterButton;
                button.classList.toggle("active", active);
                button.setAttribute("aria-pressed", String(active));
            });
            applyTransitFilter();
        });
    });

    transitCards.forEach(card => {
        card.addEventListener("click", () => card.classList.toggle("is-expanded"));
    });

    function refreshTransit() {
        transitRefresh.disabled = true;
        transitRefresh.textContent = "Updating…";
        window.setTimeout(() => {
            transitCards.forEach(card => {
                const currentMinutes = Number(card.dataset.minutes);
                const nextMinutes = Math.max(3, currentMinutes - 1 + Math.floor(Math.random() * 3));
                card.dataset.minutes = String(nextMinutes);
                card.querySelector(".transit-time").textContent = nextMinutes;
            });
            transitUpdated.textContent = `Updated just now · ${document.querySelectorAll(".transit-card:not(.filter-hidden)").length} routes shown`;
            transitRefresh.disabled = false;
            transitRefresh.textContent = "Refresh";
        }, 500);
    }

    transitRefresh.addEventListener("click", event => {
        event.stopPropagation();
        refreshTransit();
    });
    applyTransitFilter();

    const mapLayerButtons = document.querySelectorAll(".filter-chip[data-layer]");
    const mapLayerState = {};

    function updateMapLayer(layer, isVisible) {
        mapLayerState[layer] = isVisible;
        document.querySelectorAll(`.marker[data-layer="${layer}"]`).forEach(marker => {
            marker.hidden = !isVisible;
            if (!isVisible) marker.classList.remove("selected");
        });
        const visibleMarkers = document.querySelectorAll(".marker:not([hidden])").length;
        mapFooterText.textContent = `${visibleMarkers} marker${visibleMarkers === 1 ? "" : "s"} shown with your current layers. Tap a marker for live detail.`;
    }

    mapLayerButtons.forEach(layerButton => {
        const layer = layerButton.dataset.layer;
        const initialState = layerButton.getAttribute("aria-pressed") === "true";
        mapLayerState[layer] = initialState;
        layerButton.addEventListener("click", event => {
            event.preventDefault();
            const isActive = !mapLayerState[layer];
            layerButton.classList.toggle("active", isActive);
            layerButton.setAttribute("aria-pressed", String(isActive));
            updateMapLayer(layer, isActive);
        });
        updateMapLayer(layer, initialState);
    });

    document.querySelectorAll(".marker[data-layer]").forEach(marker => {
        marker.addEventListener("click", () => {
            document.querySelectorAll(".marker").forEach(item => item.classList.remove("selected"));
            marker.classList.add("selected");
            mapDetailCard.querySelector("h3").textContent = marker.dataset.title;
            mapDetailCard.querySelector("p").textContent = marker.dataset.detail;
        });
    });

    if (mapCanvas && mapStage) {
        let mapScale = 1;
        let mapOffsetX = 0;
        let mapOffsetY = 0;
        let dragStartX = 0;
        let dragStartY = 0;
        let startOffsetX = 0;
        let startOffsetY = 0;

        function renderMapTransform() {
            mapStage.style.transform = `translate(${mapOffsetX}px, ${mapOffsetY}px) scale(${mapScale})`;
        }

        function setMapZoom(nextScale) {
            mapScale = Math.min(2.2, Math.max(0.85, nextScale));
            renderMapTransform();
        }

        document.getElementById("map-zoom-in").addEventListener("click", event => {
            event.stopPropagation();
            setMapZoom(mapScale + 0.2);
        });
        document.getElementById("map-zoom-out").addEventListener("click", event => {
            event.stopPropagation();
            setMapZoom(mapScale - 0.2);
        });
        document.getElementById("map-zoom-reset").addEventListener("click", event => {
            event.stopPropagation();
            mapScale = 1;
            mapOffsetX = 0;
            mapOffsetY = 0;
            renderMapTransform();
            mapLayerButtons.forEach(layerButton => {
                const isDefaultLayer = layerButton.dataset.layer === "closures";
                layerButton.classList.toggle("active", isDefaultLayer);
                layerButton.setAttribute("aria-pressed", String(isDefaultLayer));
                updateMapLayer(layerButton.dataset.layer, isDefaultLayer);
            });
            document.querySelectorAll(".marker").forEach(marker => marker.classList.remove("selected"));
            mapDetailCard.querySelector("h3").textContent = "Select a marker";
            mapDetailCard.querySelector("p").textContent = "Choose a colored dot to see live campus information.";
        });

        mapCanvas.addEventListener("wheel", event => {
            event.preventDefault();
            setMapZoom(mapScale + (event.deltaY < 0 ? 0.1 : -0.1));
        }, { passive: false });

        mapCanvas.addEventListener("pointerdown", event => {
            if (event.target.closest(".marker, .map-zoom-controls")) return;
            mapCanvas.setPointerCapture(event.pointerId);
            mapCanvas.classList.add("is-dragging");
            dragStartX = event.clientX;
            dragStartY = event.clientY;
            startOffsetX = mapOffsetX;
            startOffsetY = mapOffsetY;
        });
        mapCanvas.addEventListener("pointermove", event => {
            if (!mapCanvas.hasPointerCapture(event.pointerId)) return;
            mapOffsetX = startOffsetX + event.clientX - dragStartX;
            mapOffsetY = startOffsetY + event.clientY - dragStartY;
            renderMapTransform();
        });
        mapCanvas.addEventListener("pointerup", event => {
            mapCanvas.releasePointerCapture(event.pointerId);
            mapCanvas.classList.remove("is-dragging");
        });
        mapCanvas.addEventListener("pointercancel", event => {
            mapCanvas.releasePointerCapture(event.pointerId);
            mapCanvas.classList.remove("is-dragging");
        });
    }

    document.addEventListener("click", event => {
        if (event.target.closest("#btn-detour")) {
            switchView("map");
            return;
        }

        const dismissButton = event.target.closest(".btn-dismiss-alert");
        if (dismissButton) {
            dismissAlert();
            return;
        }

        const restoreButton = event.target.closest("[data-restore-alert]");
        if (restoreButton) {
            const alertId = restoreButton.dataset.restoreAlert;
            const alerts = loadDismissedAlerts();
            const alert = alerts.find(savedAlert => savedAlert.id === alertId);
            if (!alert || document.getElementById("live-alert-card")) return;

            saveDismissedAlerts(alerts.filter(savedAlert => savedAlert.id !== alertId));
            restoreAlert(alert);
            renderDismissedAlerts();
        }
    });


    function switchView(viewId) {
        views.forEach(view => view.classList.remove("active"));
        
        const targetView = document.getElementById(`view-${viewId}`);
        if (targetView) {
            targetView.classList.add("active");
        }

        tabs.forEach(tab => tab.classList.remove("active"));
        tabs.forEach(tab => tab.removeAttribute("aria-current"));
        
        const targetTab = document.querySelector(`[data-view="${viewId}"]`);
        if (targetTab) {
            targetTab.classList.add("active");
            targetTab.setAttribute("aria-current", "page");
        }

        if (mainContent) {
            mainContent.scrollTop = 0;
        }
    }

    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            const targetViewId = tab.getAttribute("data-view");
            switchView(targetViewId);
        });
    });

    const btnDetour = document.getElementById("btn-detour");
    if (btnDetour) {
        btnDetour.addEventListener("click", () => {
            switchView("map");
        });
    }

    const HELD_SEATS_KEY = "campus-app-held-study-seats";
    const studyCards = document.querySelectorAll(".study-card[data-study-id]");
    const studyFilters = document.querySelectorAll("[data-study-filter]");
    const studyEmptyState = document.getElementById("study-empty-state");
    const activeStudyFilters = new Set();

    function applyStudyFilters() {
        const categoryFilters = ["quiet", "group"].filter(filter => activeStudyFilters.has(filter));
        const requiresOpenNow = activeStudyFilters.has("open");
        let visibleCount = 0;

        studyCards.forEach(card => {
            const matchesType = categoryFilters.length === 0
                || categoryFilters.some(filter => card.dataset.studyTypes.includes(filter));
            const matchesOpen = !requiresOpenNow || card.dataset.studyOpen === "true";
            const isVisible = matchesType && matchesOpen;

            card.classList.toggle("filter-hidden", !isVisible);
            if (isVisible) visibleCount += 1;
        });

        studyEmptyState.hidden = visibleCount > 0;
        if (visibleCount === 0) {
            const selectedLabels = [...activeStudyFilters]
                .map(filter => document.querySelector(`[data-study-filter="${filter}"]`).textContent.trim());
            studyEmptyState.textContent = `No spots match ${selectedLabels.join(" + ")} yet.`;
        }
    }

    studyFilters.forEach(filterButton => {
        filterButton.addEventListener("click", () => {
            const filter = filterButton.dataset.studyFilter;
            if (filter === "all") {
                activeStudyFilters.clear();
            } else if (activeStudyFilters.has(filter)) {
                activeStudyFilters.delete(filter);
            } else {
                activeStudyFilters.add(filter);
            }

            const hasSpecificFilter = activeStudyFilters.size > 0;
            studyFilters.forEach(button => {
                const buttonFilter = button.dataset.studyFilter;
                const isActive = buttonFilter === "all"
                    ? !hasSpecificFilter
                    : activeStudyFilters.has(buttonFilter);
                button.classList.toggle("active", isActive);
                button.setAttribute("aria-pressed", String(isActive));
            });
            applyStudyFilters();
        });
    });

    applyStudyFilters();

    function loadHeldSeats() {
        try {
            const heldSeats = JSON.parse(localStorage.getItem(HELD_SEATS_KEY) || "[]");
            return Array.isArray(heldSeats) ? heldSeats : [];
        } catch (error) {
            console.error("Unable to load held study seats.", error);
            return [];
        }
    }

    function saveHeldSeats(heldSeats) {
        try {
            localStorage.setItem(HELD_SEATS_KEY, JSON.stringify(heldSeats));
        } catch (error) {
            console.error("Unable to save held study seats.", error);
        }
    }

    function updateStudyCard(card, isHeld) {
        const fill = card.querySelector(".progress-bar-fill");
        const label = card.querySelector(".progress-label");
        const button = card.querySelector(".btn-hold-seat");
        const baseCapacity = Number(fill.dataset.capacity);
        const capacity = Math.min(100, baseCapacity + (isHeld ? 5 : 0));

        fill.style.width = `${capacity}%`;
        label.textContent = `${capacity}% full`;
        button.classList.toggle("is-held", isHeld);
        button.disabled = false;
        button.setAttribute("aria-pressed", String(isHeld));
        button.textContent = isHeld ? "✓ Release seat" : "Hold a seat";
        card.classList.toggle("seat-reserved", isHeld);
    }

    const heldSeats = loadHeldSeats();
    document.querySelectorAll(".study-card[data-study-id]").forEach(card => {
        updateStudyCard(card, heldSeats.includes(card.dataset.studyId));
    });

    document.addEventListener("click", event => {
        const button = event.target.closest(".btn-hold-seat");
        if (!button) return;

        const card = button.closest(".study-card[data-study-id]");
        if (!card) return;

        const studyId = card.dataset.studyId;
        const heldSeats = loadHeldSeats();
        const isHeld = heldSeats.includes(studyId);
        const updatedHeldSeats = isHeld
            ? heldSeats.filter(heldStudyId => heldStudyId !== studyId)
            : [...new Set([...heldSeats, studyId])];
        saveHeldSeats(updatedHeldSeats);
        updateStudyCard(card, !isHeld);
    });

    const toggleSwitch = document.getElementById("notifySwitch");
    if (toggleSwitch) {
        const notifySubtitle = document.getElementById("notifySubtitle");
        const notifyStatus = document.getElementById("notifyStatus");
        const NOTIFY_PREFERENCE_KEY = "campus-app-notify-before-arrival";

        function setNotificationPreference(isEnabled, showFeedback = false) {
            toggleSwitch.classList.toggle("active", isEnabled);
            toggleSwitch.dataset.state = isEnabled ? "on" : "off";
            toggleSwitch.setAttribute("aria-checked", String(isEnabled));
            notifySubtitle.textContent = isEnabled
                ? "You'll get a reminder 10 min before your route."
                : "Alerts 10 min out on your commute route";
            notifyStatus.textContent = isEnabled
                ? "Notifications are on"
                : "Notifications are off";
            notifyStatus.classList.toggle("visible", showFeedback || isEnabled);

            try {
                localStorage.setItem(NOTIFY_PREFERENCE_KEY, String(isEnabled));
            } catch (error) {
                console.error("Unable to save notification preference.", error);
            }

            if (showFeedback) {
                window.clearTimeout(setNotificationPreference.feedbackTimeout);
                setNotificationPreference.feedbackTimeout = window.setTimeout(() => {
                    notifyStatus.classList.remove("visible");
                }, 2600);
            }
        }

        let savedPreference = false;
        try {
            savedPreference = localStorage.getItem(NOTIFY_PREFERENCE_KEY) === "true";
        } catch (error) {
            console.error("Unable to load notification preference.", error);
        }
        setNotificationPreference(savedPreference);

        toggleSwitch.addEventListener("click", () => {
            if (toggleSwitch.classList.contains("disabled")) return;
            setNotificationPreference(toggleSwitch.dataset.state !== "on", true);
            ejecutarAccionDeAlerta(toggleSwitch.dataset.state);
        });
    }

        // Función de ejemplo para procesar el estado
        function ejecutarAccionDeAlerta(estado) {
            if (estado === "on") {
                console.log("🔔 Alertas activadas: El usuario recibirá notificaciones 10 min antes.");
                // Aquí iría tu código para activar geolocalización o notificaciones push
            } else {
                console.log("🔕 Alertas desactivadas.");
            }
        }
});