import React, { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import "leaflet-draw";
import leafletImage from "leaflet-image";
import Papa from "papaparse";
import "./App.css";

// Fix Leaflet marker icons which sometimes don't load correctly in React
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require("leaflet/dist/images/marker-icon-2x.png"),
  iconUrl: require("leaflet/dist/images/marker-icon.png"),
  shadowUrl: require("leaflet/dist/images/marker-shadow.png"),
});

L.drawLocal.draw.toolbar.actions.title = 'Cancel drawing';
L.drawLocal.draw.toolbar.actions.text = 'Cancel';
L.drawLocal.draw.toolbar.finish.title = 'Save as government record';
L.drawLocal.draw.toolbar.finish.text = 'Save Gov Record';
L.drawLocal.draw.toolbar.undo.title = 'Delete last point drawn';
L.drawLocal.draw.toolbar.undo.text = 'Undo point';

L.drawLocal.edit.toolbar.actions.save.title = 'Save changes';
L.drawLocal.edit.toolbar.actions.save.text = 'Save';
L.drawLocal.edit.toolbar.actions.cancel.title = 'Cancel editing, discards all changes';
L.drawLocal.edit.toolbar.actions.cancel.text = 'Cancel';
L.drawLocal.edit.toolbar.actions.clearAll.text = 'Clear All';

L.drawLocal.edit.toolbar.buttons.edit = 'Edit Record';
L.drawLocal.edit.toolbar.buttons.editDisabled = 'No records to edit';
L.drawLocal.edit.toolbar.buttons.remove = 'Delete Record';
L.drawLocal.edit.toolbar.buttons.removeDisabled = 'No records to delete';

function App() {
  const historicalSources = {
    osm: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    clarity: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    natgeo: 'https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}',
  };

  const mapContainer = useRef(null);
  const mapContainer2 = useRef(null);
  const mapRef = useRef(null);
  const mapRef2 = useRef(null);
  const drawnItemsRef = useRef(new L.FeatureGroup());
  const drawnItemsRef2 = useRef(new L.FeatureGroup());
  const fileInputRef = useRef(null);

  const [govLands, setGovLands] = useState([]);
  const [encroachments, setEncroachments] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState(null);
  const [currentCoords, setCurrentCoords] = useState(null); // Will store as [lng, lat] for backend consistency
  const [formData, setFormData] = useState({ owner: "", phone: "", email: "" });
  const [splitMode, setSplitMode] = useState(false);
  const [swipeMode, setSwipeMode] = useState(false);
  const [swipeValue, setSwipeValue] = useState(50);
  const [histSource, setHistSource] = useState('clarity');
  const [activeMap, setActiveMap] = useState('old'); // 'old' or 'recent'
  const primaryLayerRef = useRef(null);
  const historicalLayerRef = useRef(null);
  const historicalLayerRef2 = useRef(null);

  // Remaining ML states kept for modal fallback if needed
  const [mlResult, setMlResult] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

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

      drawnItemsRef.current.eachLayer(layer => {
        if (layer.feature && layer.feature.properties && layer.feature.properties.type === 'govland') {
          drawnItemsRef.current.removeLayer(layer);
        }
      });
      if (drawnItemsRef2.current) {
        drawnItemsRef2.current.eachLayer(layer => {
          if (layer.feature && layer.feature.properties && layer.feature.properties.type === 'govland') {
            drawnItemsRef2.current.removeLayer(layer);
          }
        });
      }

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
               style="display: block; background: #0ea5e9; color: white; text-align: center; padding: 5px; border-radius: 4px; text-decoration: none; font-size: 11px; font-weight: bold; margin-bottom: 5px;">
               📄 Download Official Report
            </a>
            <button onclick="window.triggerEncroachmentCheck(${l.id})" 
               style="display: block; width: 100%; background: #ef4444; color: white; text-align: center; padding: 5px; border-radius: 4px; border: none; cursor: pointer; font-size: 11px; font-weight: bold;">
               🔍 Run Encroachment Check
            </button>
          </div>
        `;

        const geo = L.geoJSON(g, { style });
        geo.eachLayer(layer => {
          layer.bindPopup(popup);
          layer.feature = layer.feature || { type: 'Feature', properties: {} };
          layer.feature.properties.id = l.id;
          layer.feature.properties.type = 'govland';
          drawnItemsRef.current.addLayer(layer);

          if (mapRef2.current) {
            const mirrorGeo = L.geoJSON(g, { style });
            mirrorGeo.eachLayer(mLayer => {
              mLayer.bindPopup(popup);
              mLayer.feature = mLayer.feature || { type: 'Feature', properties: {} };
              mLayer.feature.properties.id = l.id;
              mLayer.feature.properties.type = 'govland';
              drawnItemsRef2.current.addLayer(mLayer);
            });
          }
        });
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
      primaryLayerRef.current = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Esri World Imagery',
        className: 'current-satellite-layer'
      });
      // Default is Old Map (primary hidden). Layer toggle handled in separate effect.

      mapRef.current.addLayer(drawnItemsRef.current);

      const drawControl = new L.Control.Draw({
        edit: { 
          featureGroup: drawnItemsRef.current,
          edit: false,
          remove: true
        },
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
        setModalType('G'); // Directly choose Gov Record
        setShowModal(true);
      });

      mapRef.current.on(L.Draw.Event.EDITED, async (e) => {
        const layers = e.layers;
        const updatePromises = [];
        layers.eachLayer((layer) => {
          if (layer.feature && layer.feature.properties && layer.feature.properties.id) {
            const coords = layer.toGeoJSON().geometry.coordinates[0];
            updatePromises.push(
              fetch(`http://localhost:5001/govland/${layer.feature.properties.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ coords })
              })
            );
          }
        });
        await Promise.all(updatePromises);
        loadGovLands();
      });

      mapRef.current.on(L.Draw.Event.DELETED, async (e) => {
        const layers = e.layers;
        if (window.confirm("Are you sure you want to completely delete these records?")) {
          const deletePromises = [];
          layers.eachLayer((layer) => {
            if (layer.feature && layer.feature.properties && layer.feature.properties.id) {
              deletePromises.push(
                fetch(`http://localhost:5001/govland/${layer.feature.properties.id}`, {
                  method: "DELETE"
                })
              );
            }
          });
          await Promise.all(deletePromises);
          loadGovLands();
        } else {
          loadGovLands(); // Undo local delete
        }
      });
    }

    if (splitMode && !mapRef2.current) {
      mapRef2.current = L.map(mapContainer2.current).setView(mapRef.current.getCenter(), mapRef.current.getZoom());

      historicalLayerRef2.current = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Recent Satellite Comparison'
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
    // We intentionally ignore historicalLayerRef2 because it should lock to recent satellite!

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

  useEffect(() => {
    if (primaryLayerRef.current && mapRef.current) {
      if (swipeMode || activeMap === 'recent') {
        if (!mapRef.current.hasLayer(primaryLayerRef.current)) {
          primaryLayerRef.current.addTo(mapRef.current);
        }
      } else {
        if (mapRef.current.hasLayer(primaryLayerRef.current)) {
          primaryLayerRef.current.removeFrom(mapRef.current);
        }
      }
    }
  }, [activeMap, swipeMode]);

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

  const handleCsvUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const records = results.data;
        let successCount = 0;
        let errorCount = 0;

        for (const record of records) {
          try {
            // Expecting coords as "long1 lat1, long2 lat2, long3 lat3..."
            const coordString = record.coordinates || record.coords;
            const owner = record.owner || record.owner_name;
            const phone = record.phone || "";
            const email = record.email || "";

            if (!coordString || !owner) {
              console.warn("Skipping invalid record:", record);
              errorCount++;
              continue;
            }

            const coords = coordString.split(",").map(pair => {
              const [lng, lat] = pair.trim().split(/\s+/).map(Number);
              return [lng, lat];
            });

            await fetch("http://localhost:5001/govland", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ coords, owner, phone, email }),
            });
            successCount++;
          } catch (err) {
            console.error("Failed to upload record:", record, err);
            errorCount++;
          }
        }

        alert(`Bulk upload complete!\nSuccess: ${successCount}\nErrors: ${errorCount}`);
        loadGovLands();
        
        // Zoom to first new record if available
        if (successCount > 0 && records[0]) {
           const firstCoord = records[0].coordinates || records[0].coords;
           const [lng, lat] = firstCoord.split(",")[0].trim().split(/\s+/).map(Number);
           mapRef.current.setView([lat, lng], 15);
        }
      }
    });
    // Reset file input
    e.target.value = null;
  };

  useEffect(() => {
    window.triggerEncroachmentCheck = (id) => runEncroachmentCheck(id);
    return () => delete window.triggerEncroachmentCheck;
  }, [govLands, splitMode, histSource]);

  const runEncroachmentCheck = async (id) => {
    let targetLayer = null;
    drawnItemsRef.current.eachLayer(layer => {
      if (layer.feature?.properties?.id === id) targetLayer = layer;
    });
    if (!targetLayer) return;

    setAnalyzing(true);
    setMlResult(null);
    setModalType('AI');
    setShowModal(true);

    try {
      const bounds = targetLayer.getBounds();
      mapRef.current.fitBounds(bounds, { maxZoom: 18 });

      if (splitMode) {
        await new Promise(r => setTimeout(r, 1000));
        const blob1 = await new Promise((resolve) => {
          leafletImage(mapRef2.current, (err, canvas) => {
            if (err) resolve(null); else canvas.toBlob(resolve, 'image/png');
          }); 
        });
        const blob2 = await new Promise((resolve) => {
          leafletImage(mapRef.current, (err, canvas) => {
            if (err) resolve(null); else canvas.toBlob(resolve, 'image/png');
          }); 
        });

        if (!blob1 || !blob2) throw new Error("Could not capture maps.");
        const formData = new FormData();
        formData.append("base_image", blob2);
        formData.append("current_image", blob1);
        const res = await fetch("http://localhost:8000/detect", { method: "POST", body: formData });
        setMlResult(await res.json());
      } else {
        const histMap = L.map('hidden-map-base', { zoomControl: false, attributionControl: false }).fitBounds(bounds, { maxZoom: 18 });
        const recMap = L.map('hidden-map-curr', { zoomControl: false, attributionControl: false }).fitBounds(bounds, { maxZoom: 18 });
        
        L.tileLayer(historicalSources[histSource] || historicalSources.osm).addTo(histMap);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(recMap);
        
        await new Promise(r => setTimeout(r, 1500));
        
        const blob1 = await new Promise((resolve) => {
          leafletImage(recMap, (err, canvas) => {
            if (err) resolve(null); else canvas.toBlob(resolve, 'image/png');
          }); 
        });
        const blob2 = await new Promise((resolve) => {
          leafletImage(histMap, (err, canvas) => {
            if (err) resolve(null); else canvas.toBlob(resolve, 'image/png');
          }); 
        });

        histMap.remove();
        recMap.remove();
        
        if (!blob1 || !blob2) throw new Error("Could not capture background maps.");
        
        const formData = new FormData();
        formData.append("base_image", blob2);
        formData.append("current_image", blob1);
        const res = await fetch("http://localhost:8000/detect", { method: "POST", body: formData });
        setMlResult(await res.json());
      }
    } catch (err) {
      console.error("AI Scan Error:", err);
      alert("ML Engine Error. Check if python main.py is running!");
      setShowModal(false);
    } finally {
      setAnalyzing(false);
    }
  };

  const zoomToRecord = (id) => {
    drawnItemsRef.current.eachLayer(layer => {
      if (layer.feature && layer.feature.properties && layer.feature.properties.id === id) {
        const bounds = layer.getBounds();
        mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
        layer.openPopup();
      }
    });
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
          <h3>Map View</h3>
          <div className="tool-buttons">
            <button
              className={`btn btn-sm ${activeMap === 'old' && !splitMode ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setActiveMap('old'); setSplitMode(false); setSwipeMode(false); }}
            >
              🕰️ Old Map
            </button>
            <button
              className={`btn btn-sm ${activeMap === 'recent' && !splitMode ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setActiveMap('recent'); setSplitMode(false); setSwipeMode(false); }}
            >
              🛰️ Most Recent Map
            </button>
          </div>
        </div>

        <div className="sidebar-section">
          <h3>Tools & Analysis</h3>
          <div className="tool-buttons">
            <button
              className={`btn btn-sm ${splitMode ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setSplitMode(!splitMode); setSwipeMode(false); setActiveMap('old'); }}
            >
              {splitMode ? "🗙 Disable Split" : "🗖 Dual Map View"}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => fileInputRef.current.click()}
              style={{ border: "1px dashed #38bdf8", marginTop: "10px" }}
            >
              📥 Bulk Upload (CSV)
            </button>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: "none" }}
              accept=".csv"
              onChange={handleCsvUpload}
            />
          </div>

          {splitMode && (
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
                <div 
                  key={l.id} 
                  className="record-item" 
                  onClick={() => zoomToRecord(l.id)}
                  style={{ cursor: "pointer" }}
                >
                  <div className="record-info">
                    <strong>{l.owner_name}</strong>
                    <span>{l.total_area.toFixed(0)} m²</span>
                  </div>
                  <a 
                    href={`http://localhost:5001/generate-report/${l.id}`} 
                    className="mini-btn" 
                    title="Download Report"
                    onClick={(e) => e.stopPropagation()}
                  >
                    📄
                  </a>
                </div>
              ))
            }
          </div>
        </div>



        <div className="sidebar-footer">
          <p>Government Portal | Real-Time Monitoring</p>
        </div>
      </div>

      <div className={`map-wrapper ${splitMode ? 'split' : ''} ${swipeMode ? 'swipe' : ''} ${activeMap === 'recent' && !splitMode ? 'disable-draw' : ''}`}>
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
              ) : modalType === 'AI' ? (
                <>
                  <h2>AI Background Analysis</h2>
                  {analyzing ? (
                    <div style={{ padding: "40px 0", textAlign: "center" }}>
                      <div className="spinner" style={{ margin: "0 auto 20px auto", width: "40px", height: "40px", border: "4px solid #f3f3f3", borderTop: "4px solid #0ea5e9", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                      <p>Processing structural changes...</p>
                    </div>
                  ) : mlResult ? (
                    <div className="ml-results">
                      <div className={`status-badge ${mlResult.change_detected ? 'danger' : 'safe'}`}>
                        {mlResult.change_detected ? '🚨 High Encroachment Probability' : '✅ Clear (No Structural Changes)'}
                      </div>
                      <div className="metrics-grid">
                        <div className="metric">
                          <span>Structural Change</span>
                          <strong>{mlResult.change_percentage}%</strong>
                        </div>
                        <div className="metric">
                          <span>Forensic Score</span>
                          <strong>{mlResult.structural_score}</strong>
                        </div>
                      </div>
                      <div style={{ marginTop: "10px", fontSize: "12px", color: "#64748b" }}>
                        Debug: {mlResult.debug_stats.new_lines} new signatures, {mlResult.debug_stats.new_corners} corners.
                      </div>
                      <button className="btn btn-primary" onClick={() => setShowModal(false)} style={{ marginTop: "20px", width: "100%" }}>Acknowledge</button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div id="hidden-map-base" className="hidden-map-capture"></div>
      <div id="hidden-map-curr" className="hidden-map-capture"></div>
    </div>
  );
}
export default App;
