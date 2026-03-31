import React, { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import "leaflet-draw";
import leafletImage from "leaflet-image";
import "./App.css";

// Fix Leaflet marker icons which sometimes don't load correctly in React
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require("leaflet/dist/images/marker-icon-2x.png"),
  iconUrl: require("leaflet/dist/images/marker-icon.png"),
  shadowUrl: require("leaflet/dist/images/marker-shadow.png"),
});

function App() {
  const mapContainer = useRef(null);
  const mapContainer2 = useRef(null);
  const mapRef = useRef(null);
  const mapRef2 = useRef(null);
  const drawnItemsRef = useRef(new L.FeatureGroup());
  const drawnItemsRef2 = useRef(new L.FeatureGroup());

  const [govLands, setGovLands] = useState([]);
  const [encroachments, setEncroachments] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState(null);
  const [currentCoords, setCurrentCoords] = useState(null); // Will store as [lng, lat] for backend consistency
  const [formData, setFormData] = useState({ owner: "", phone: "", email: "" });
  const [mlImages, setMlImages] = useState({ base: null, current: null });
  const [mlResult, setMlResult] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  const [swipeMode, setSwipeMode] = useState(false);
  const [swipeValue, setSwipeValue] = useState(50);
  const [histSource, setHistSource] = useState('clarity');
  const historicalLayerRef = useRef(null);
  const historicalLayerRef2 = useRef(null);

  // Sync function helper
  const syncMaps = useCallback((source, target) => {
    if (!source || !target) return;
    target.setView(source.getCenter(), source.getZoom(), { animate: false });
  }, []);

  const loadGovLands = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:5001/govlands");
      const data = await res.json();
      setGovLands(data);

      data.forEach((l) => {
        const g = JSON.parse(l.geom);
        const style = { color: "#38bdf8", weight: 2, fillOpacity: 0.3 };
        const popup = `
          <div style="color: #1e293b; min-width: 150px;">
            <strong style="color: #38bdf8">Government Land</strong><br/>
            <strong>Owner:</strong> ${l.owner_name}<br/>
            <strong>Area:</strong> ${l.total_area.toFixed(2)} m²<br/>
            <hr style="border: 0.5px solid #cbd5e1; margin: 8px 0;"/>
            <a href="http://localhost:5001/generate-report/${l.id}" target="_blank" 
               style="display: block; background: #0ea5e9; color: white; text-align: center; padding: 5px; border-radius: 4px; text-decoration: none; font-size: 11px; font-weight: bold;">
               📄 Download Official Report
            </a>
          </div>
        `;

        L.geoJSON(g, { style }).bindPopup(popup).addTo(mapRef.current);
        if (mapRef2.current) L.geoJSON(g, { style }).bindPopup(popup).addTo(mapRef2.current);
      });
    } catch (err) {
      console.error("Failed to load gov lands", err);
    }
  }, []);

  const loadEncroachments = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:5001/encroachments");
      const data = await res.json();
      setEncroachments(data);

      data.forEach((e) => {
        const g = JSON.parse(e.geom);
        const style = { color: "#ef4444", weight: 2, fillOpacity: 0.5 };
        const popup = `
          <div style="color: #1e293b">
            <strong style="color: #ef4444">⚠ Encroachment</strong><br/>
            <strong>Detected:</strong> ${new Date(e.detected_at).toLocaleDateString()}<br/>
            <strong>Area:</strong> ${e.encroached_area.toFixed(2)} m²
          </div>
        `;

        L.geoJSON(g, { style }).bindPopup(popup).addTo(mapRef.current);
        if (mapRef2.current) L.geoJSON(g, { style }).bindPopup(popup).addTo(mapRef2.current);
      });
    } catch (err) {
      console.error("Failed to load encroachments", err);
    }
  }, []);

  useEffect(() => {
    if (!mapRef.current) {
      mapRef.current = L.map(mapContainer.current).setView([13.08, 80.27], 12);

      // Secondary Layer (Old/Historical)
      const historicalSources = {
        osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
        clarity: L.tileLayer('https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'),
        natgeo: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}'),
      };

      historicalLayerRef.current = historicalSources[histSource] || historicalSources.osm;
      historicalLayerRef.current.addTo(mapRef.current);

      // Primary Layer (Current Satellite)
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Esri World Imagery',
        className: 'current-satellite-layer'
      }).addTo(mapRef.current);

      mapRef.current.addLayer(drawnItemsRef.current);

      const drawControl = new L.Control.Draw({
        edit: { featureGroup: drawnItemsRef.current },
        draw: {
          polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#38bdf8' } },
          polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false,
        }
      });
      mapRef.current.addControl(drawControl);
      mapRef.current.on(L.Draw.Event.CREATED, (e) => {
        const layer = e.layer;
        drawnItemsRef.current.addLayer(layer);

        // Mirror to Map 2 if it exists
        if (mapRef2.current) {
          const geojson = layer.toGeoJSON();
          const mirroredLayer = L.geoJSON(geojson, { color: '#38bdf8' });
          drawnItemsRef2.current.addLayer(mirroredLayer);
        }

        setCurrentCoords(layer.toGeoJSON().geometry.coordinates[0]);
        setShowModal(true);
      });
    }

    if (splitMode && !mapRef2.current) {
      mapRef2.current = L.map(mapContainer2.current).setView(mapRef.current.getCenter(), mapRef.current.getZoom());

      const historicalSources = {
        osm: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        clarity: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        natgeo: 'https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}',
      };

      historicalLayerRef2.current = L.tileLayer(historicalSources[histSource], {
        attribution: 'Historical Comparison'
      }).addTo(mapRef2.current);

      mapRef2.current.addLayer(drawnItemsRef2.current);
    } else if (!splitMode && mapRef2.current) {
      mapRef2.current.remove();
      mapRef2.current = null;
    }

    // Sync Handlers
    const onMove1 = () => syncMaps(mapRef.current, mapRef2.current);
    const onMove2 = () => syncMaps(mapRef2.current, mapRef.current);

    if (mapRef.current && mapRef2.current) {
      mapRef.current.on('move zoom', onMove1);
      mapRef2.current.on('move zoom', onMove2);
    }

    const historicalSources = {
      osm: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      clarity: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      natgeo: 'https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}',
    };

    if (historicalLayerRef.current) {
      historicalLayerRef.current.setUrl(historicalSources[histSource]);
    }
    if (historicalLayerRef2.current) {
      historicalLayerRef2.current.setUrl(historicalSources[histSource]);
    }

    loadGovLands();
    loadEncroachments();

    return () => {
      if (mapRef.current) {
        mapRef.current.off('move zoom', onMove1);
      }
      if (mapRef2.current) {
        mapRef2.current.off('move zoom', onMove2);
      }
    };
  }, [splitMode, loadGovLands, loadEncroachments, syncMaps, histSource]);

  const handleSave = async () => {
    if (!modalType) return;

    try {
      if (modalType === "G") {
        await fetch("http://localhost:5001/govland", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            coords: currentCoords,
            owner: formData.owner,
            phone: formData.phone,
            email: formData.email
          }),
        });
        loadGovLands();
      } else {
        const res = await fetch("http://localhost:5001/newland", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ coords: currentCoords }),
        });
        const data = await res.json();
        if (data.encroached) {
          alert(`🚨 ALERT: Encroachment Detected!\nArea: ${data.area} m²`);
        } else {
          alert("✅ No Encroachment Detected");
        }
        loadEncroachments();
      }
    } catch (err) {
      console.error("Operation failed", err);
    }

    setShowModal(false);
    setModalType(null);
    setFormData({ owner: "", phone: "", email: "" });
  };

  const runAutomatedAIScan = async () => {
    if (!mapRef.current || !mapRef2.current) {
      alert("Please enable Dual Map View/Split Mode for Automated AI Scan.");
      return;
    }

    setAnalyzing(true);
    try {
      // 1. Capture Current Satellite Map (Map 1)
      const blob1 = await new Promise((resolve) => {
        leafletImage(mapRef.current, (err, canvas) => {
          if (err) { console.error(err); resolve(null); }
          canvas.toBlob(resolve, 'image/png');
        });
      });

      // 2. Capture Historical Map (Map 2)
      const blob2 = await new Promise((resolve) => {
        leafletImage(mapRef2.current, (err, canvas) => {
          if (err) { console.error(err); resolve(null); }
          canvas.toBlob(resolve, 'image/png');
        });
      });

      if (!blob1 || !blob2) throw new Error("Could not capture map snapshots.");

      const formData = new FormData();
      formData.append("base_image", blob2); // Historical
      formData.append("current_image", blob1); // Current

      const res = await fetch("http://localhost:8000/detect", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      setMlResult(data);
    } catch (err) {
      console.error("AI Scan Error:", err);
      alert("Automated AI Scan failed. Ensure ML Engine is running on Port 8000.");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleMLAnalysis = async () => {
    if (!mlImages.base || !mlImages.current) {
      alert("Please upload both snapshots first.");
      return;
    }

    setAnalyzing(true);
    setMlResult(null);

    const formData = new FormData();
    formData.append("base_image", mlImages.base);
    formData.append("current_image", mlImages.current);

    try {
      const res = await fetch("http://localhost:8000/detect", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      setMlResult(data);
    } catch (err) {
      console.error("ML Service Error:", err);
      alert("ML Engine Offline. Please start main.py in LandsecureX_ML folder.");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="app-container">
      <div className="sidebar">
        <h1>LandSecureX 🛡️</h1>

        <div className="stats-row">
          <div className="stats-card small">
            <h3>Registered</h3>
            <div className="value">{govLands.length}</div>
          </div>
          <div className="stats-card small">
            <h3>Threats</h3>
            <div className="value danger">{encroachments.length}</div>
          </div>
        </div>

        <div className="sidebar-section">
          <h3>Tools & Analysis</h3>
          <div className="tool-buttons">
            <button
              className={`btn btn-sm ${splitMode ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setSplitMode(!splitMode); setSwipeMode(false); }}
            >
              {splitMode ? "🗙 Disable Split" : "🗖 Dual Map View"}
            </button>
            <button
              className={`btn btn-sm ${swipeMode ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setSwipeMode(!swipeMode); setSplitMode(false); }}
            >
              {swipeMode ? "🗙 Disable Swipe" : "↔ Swipe Comparison"}
            </button>
          </div>

          {(splitMode || swipeMode) && (
            <div className="source-selector">
              <label>🕰️ Historical Base:</label>
              <select value={histSource} onChange={(e) => setHistSource(e.target.value)}>
                <option value="osm">OpenStreetMap (Structural)</option>
                <option value="clarity">ESRI Clarity (Archival Satellite)</option>
                <option value="natgeo">NatGeo (Topographic)</option>
              </select>
            </div>
          )}
        </div>

        <div className="sidebar-section">
          <h3>Government Records</h3>
          <div className="record-list">
            {govLands.length === 0 ? <p className="empty-text">No records found</p> :
              govLands.map(l => (
                <div key={l.id} className="record-item">
                  <div className="record-info">
                    <strong>{l.owner_name}</strong>
                    <span>{l.total_area.toFixed(0)} m²</span>
                  </div>
                  <a href={`http://localhost:5001/generate-report/${l.id}`} className="mini-btn" title="Download Report">📄</a>
                </div>
              ))
            }
          </div>
        </div>

        <div className="sidebar-section ml-section">
          <h3>ML Change Detection</h3>
          <p className="section-desc">Compare historical vs current snapshots.</p>
          <div className="ml-controls">
            <div className="file-input-group">
              <label>Snapshot A (Historical)</label>
              <input type="file" onChange={(e) => setMlImages({ ...mlImages, base: e.target.files[0] })} />
            </div>
            <div className="file-input-group">
              <label>Snapshot B (Current/Live)</label>
              <input type="file" onChange={(e) => setMlImages({ ...mlImages, current: e.target.files[0] })} />
            </div>

            <button
              className={`btn btn-sm ${analyzing ? 'loading' : 'btn-primary'}`}
              onClick={handleMLAnalysis}
              disabled={analyzing}
            >
              {analyzing ? "AI Analyzing..." : "Run AI Comparison"}
            </button>

            {mlResult && (
              <div className={`ml-result ${mlResult.change_detected ? 'detected' : 'safe'}`}>
                <strong>AI Status: {mlResult.change_detected ? "Encroachment Detected!" : "No Physical Change"}</strong>
                <span>Change: {mlResult.change_percentage}%</span>
                <span>Similarity: {(mlResult.similarity_score * 100).toFixed(1)}%</span>
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <p>Government Portal | Real-Time Monitoring</p>
        </div>
      </div>

      <div className={`map-wrapper ${splitMode ? 'split' : ''} ${swipeMode ? 'swipe' : ''}`}>
        <div className="map-panel" ref={mapContainer}>
          {swipeMode && (
            <div className="swipe-control">
              <input
                type="range"
                min="0" max="100"
                value={swipeValue}
                onChange={(e) => setSwipeValue(e.target.value)}
              />
              <div className="swipe-label left">Historical</div>
              <div className="swipe-label right">Satellite</div>
            </div>
          )}
          <style>
            {swipeMode ? `
              .current-satellite-layer {
                clip-path: inset(0 0 0 ${swipeValue}%);
              }
            ` : ''}
          </style>
        </div>
        {splitMode && (
          <div className="map-panel secondary" ref={mapContainer2}>
            <div className="map-label">OSM Reality Comparison</div>
          </div>
        )}

        {showModal && (
          <div className="modal-overlay">
            <div className="modal">
              {!modalType ? (
                <>
                  <h2>Register Area</h2>
                  <p className="modal-desc">Select registration intent for this selection:</p>
                  <button className="btn" onClick={() => setModalType('G')}>Official Gov Record</button>
                  <button className="btn btn-ghost" onClick={() => setModalType('N')}>Encroachment Check</button>
                </>
              ) : modalType === 'G' ? (
                <>
                  <h2>Record Details</h2>
                  <div className="form-group">
                    <label>Official Owner</label>
                    <input placeholder="Enter department/name" value={formData.owner} onChange={e => setFormData({ ...formData, owner: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Phone Contact</label>
                    <input placeholder="+91..." value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Official Email</label>
                    <input placeholder="gov@email.com" value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} />
                  </div>
                  <button className="btn" onClick={handleSave}>Save To Registry</button>
                  <button className="btn btn-ghost" onClick={() => { setShowModal(false); setModalType(null); }}>Cancel</button>
                </>
              ) : (
                <>
                  <h2>Verify Selection</h2>
                  <p className="modal-desc">Automatic AI Scan will compare current satellite vs historical data for this area.</p>

                  <div className="modal-ai-controls">
                    <button
                      className={`btn btn-sm ${analyzing ? 'loading' : 'btn-primary'}`}
                      onClick={runAutomatedAIScan}
                      disabled={analyzing}
                    >
                      {analyzing ? "AI Analyzing Area..." : "🚀 Run Automated AI Scan"}
                    </button>
                  </div>

                  {mlResult && (
                    <div className={`ml-modal-result ${mlResult.change_detected ? 'detected' : 'safe'}`}>
                      <div className="ml-badge-row">
                        <span className="ml-badge">{mlResult.method}</span>
                        <span className={`ml-badge ${mlResult.alignment_status === 'LOCKED' ? 'success' : 'warning'}`}>
                          {mlResult.alignment_status}
                        </span>
                      </div>
                      <strong>AI STATUS: {mlResult.change_detected ? "Encroachment Likely" : "No Change Detected"}</strong>
                      <div className="ml-stats">
                        <span>Change: {mlResult.change_percentage}%</span>
                        <span>Score: {mlResult.similarity_score.toFixed(2)}</span>
                        <span>Structure: {mlResult.structural_score}</span>
                      </div>
                      <div className="ml-debug-row">
                        <span>Lines: +{mlResult.debug_stats.new_lines}</span>
                        <span>Corners: +{mlResult.debug_stats.new_corners}</span>
                        <span>Noise: {mlResult.debug_stats.vars}</span>
                      </div>
                    </div>
                  )}

                  <div className="modal-actions">
                    <button className="btn danger-btn" onClick={handleSave}>Confirm Encroachment</button>
                    <button className="btn btn-ghost" onClick={() => { setShowModal(false); setModalType(null); setMlResult(null); }}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
