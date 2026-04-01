require('dotenv').config();
const nodemailer = require("nodemailer");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// Configuration
const PORT = process.env.PORT || 5001;
const DB_CONFIG = {
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "db",
  password: process.env.DB_PASSWORD || "dbpswd",
  port: parseInt(process.env.DB_PORT || "5432"),
};

const app = express();
app.use(cors());
app.use(bodyParser.json());

const pool = new Pool(DB_CONFIG);

// Auto-initialize tables if missing
const initDB = async () => {
  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'gov_land'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log("🛠️ Tables missing. Running init.sql...");
      const sqlPath = path.join(__dirname, "init.sql");
      const sql = fs.readFileSync(sqlPath, "utf8");
      await pool.query(sql);
      console.log("✅ Database initialized successfully!");
    }
  } catch (err) {
    console.error("❌ Failed to initialize database:", err.message);
  }
};

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client!', err);
});

// Email Transport
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "your email",
    pass: process.env.EMAIL_PASS || "your pswd",
  },
});

// --- Routes ---

app.get("/", (req, res) => res.send("LandSecureX Backend Running"));

app.post("/govland", async (req, res) => {
  try {
    const { coords, owner, phone, email } = req.body;
    const poly = `POLYGON((${coords.map((c) => `${c[0]} ${c[1]}`).join(",")},${coords[0][0]} ${coords[0][1]}))`;

    await pool.query(
      `
      INSERT INTO gov_land(owner_name, phone, email, geom, total_area)
      VALUES(
        $1, $2, $3,
        ST_GeomFromText($4, 4326),
        ST_Area(ST_Transform(ST_GeomFromText($4, 4326), 3857))
      )
      `,
      [owner, phone, email, poly]
    );

    res.json({ status: "saved" });
  } catch (error) {
    console.error("Error saving gov land:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/govland/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { coords } = req.body;
    const poly = `POLYGON((${coords.map((c) => `${c[0]} ${c[1]}`).join(",")},${coords[0][0]} ${coords[0][1]}))`;

    await pool.query(
      `
      UPDATE gov_land SET
        geom = ST_GeomFromText($1, 4326),
        total_area = ST_Area(ST_Transform(ST_GeomFromText($1, 4326), 3857))
      WHERE id = $2
      `,
      [poly, id]
    );
    res.json({ status: "updated" });
  } catch (error) {
    console.error("Error updating gov land:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/govland/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM gov_land WHERE id = $1`, [id]);
    res.json({ status: "deleted" });
  } catch (error) {
    console.error("Error deleting gov land:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


app.get("/encroachments", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT ST_AsGeoJSON(geom) as geom, encroached_area, detected_at FROM new_land"
    );
    res.json(r.rows);
  } catch (error) {
    console.error("Error fetching encroachments:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/newland", async (req, res) => {
  try {
    const coords = req.body.coords;
    const poly = `POLYGON((${coords.map((c) => `${c[0]} ${c[1]}`).join(",")},${coords[0][0]} ${coords[0][1]}))`;

    const result = await pool.query(
      `SELECT * FROM gov_land WHERE ST_Intersects(geom, ST_GeomFromText($1, 4326))`,
      [poly]
    );

    if (result.rowCount > 0) {
      const encAreaResult = await pool.query(
        `
        SELECT ST_Area(ST_Transform(ST_Intersection(geom, ST_GeomFromText($1, 4326)), 3857)) AS area
        FROM gov_land WHERE ST_Intersects(geom, ST_GeomFromText($1, 4326))
        `,
        [poly]
      );

      const encArea = encAreaResult.rows[0].area;
      const saveResult = await pool.query(
        "INSERT INTO new_land(geom, encroached_area) VALUES(ST_GeomFromText($1, 4326), $2) RETURNING detected_at",
        [poly, encArea]
      );

      const owner = result.rows[0];
      const detectTime = saveResult.rows[0].detected_at;

      if (owner.email && process.env.EMAIL_USER !== "your email") {
        try {
          await transporter.sendMail({
            from: `"Gov Land Alert" <${process.env.EMAIL_USER}>`,
            to: owner.email,
            subject: "⚠ Land Encroachment Alert",
            html: `<h3>Dear ${owner.owner_name},</h3><p>Encroachment detected! Area: ${encArea.toFixed(2)} sqm.</p>`
          });
        } catch (mailError) { console.error("Email failed:", mailError); }
      }

      return res.json({ encroached: true, area: encArea.toFixed(2), gov_area: owner.total_area.toFixed(2) });
    }
    res.json({ encroached: false });
  } catch (error) {
    console.error("Error processing new land:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/govlands", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, owner_name, phone, email, ST_AsGeoJSON(geom) as geom, total_area FROM gov_land"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching gov lands:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/generate-report/:id", async (req, res) => {
  const PDFDocument = require("pdfkit");
  const { id } = req.params;

  try {
    const result = await pool.query("SELECT * FROM gov_land WHERE id = $1", [id]);
    if (result.rowCount === 0) return res.status(404).send("Record not found");

    const record = result.rows[0];
    const doc = new PDFDocument({ margin: 50 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=report_${id}.pdf`);
    doc.pipe(res);

    // Header
    doc.fontSize(20).text("Government Land Record - Official Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Generated on: ${new Date().toLocaleString()}`, { align: "right" });
    doc.moveDown();
    doc.path("M 0 0 L 500 0").stroke();
    doc.moveDown();

    // Body
    doc.fontSize(14).text("Land Details", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Record ID: ${record.id}`);
    doc.text(`Owner Name: ${record.owner_name}`);
    doc.text(`Contact: ${record.phone} | ${record.email}`);
    doc.text(`Total Area: ${record.total_area.toFixed(2)} sq.m`);
    doc.text(`Coordinates Type: Polygon (WGS84)`);
    doc.moveDown();

    // Placeholder for Map Snapshot
    doc.rect(doc.x, doc.y, 400, 200).stroke();
    doc.text("Spatial Data Visualized in GIS Dashboard", doc.x + 100, doc.y + 90);
    doc.moveDown(12);

    // Verification
    doc.fontSize(10).fillColor("#444").text("This is a digitally generated document for monitoring purposes. Authorized by LandSecureX Internal Systems.", { align: "center" });

    doc.end();
  } catch (err) {
    console.error("PDF Export Error:", err);
    res.status(500).send("Report generation failed");
  }
});

// --- Server Startup ---

const server = app.listen(PORT, async () => {
  console.log(`\n🚀 LandSecureX Backend listening on http://localhost:${PORT}`);

  // Auto-initialize tables if they don't exist
  await initDB();

  // Test DB connection after server starts
  pool.connect((err, client, release) => {
    if (err) {
      console.error('❌ DB CONNECTION ERROR:', err.message);
    } else {
      console.log('✅ Successfully connected to database');
      release();
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Try a different port in .env`);
  } else {
    console.error('❌ SERVER ERROR:', err);
  }
  process.exit(1);
});

// Keep-alive interval
setInterval(() => { }, 1000000);

process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
  process.exit(1);
});
