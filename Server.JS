// ─────────────────────────────────────────────────────────────
//  FridgeChef · Backend · server.js
//  Node.js + Express · Spoonacular API integration
// ─────────────────────────────────────────────────────────────
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Logging middleware ──────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Config ──────────────────────────────────────────────────
// 🔑 Set your Spoonacular API key in .env → SPOONACULAR_API_KEY=xxxx
//    Get a free key at: https://spoonacular.com/food-api
const SPOONACULAR_KEY  = process.env.SPOONACULAR_API_KEY || '';
const SPOONACULAR_BASE = 'https://api.spoonacular.com';

// Number of recipes to fetch from Spoonacular
const MAX_RECIPES = 24;

// ── Utility Functions ───────────────────────────────────────

/**
 * Normalize an ingredient name for comparison.
 * Lowercases, strips accents, trims whitespace, and naively singularizes
 * (removes trailing 's') so "tomates" matches "tomate".
 */
function normalize(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/\s+/g, ' ')
    .replace(/s$/, ''); // naive singularize
}

/**
 * Check whether any of the user's ingredients appear in an ingredient name.
 * Supports partial substring matching (e.g. "parmesano" matches "queso parmesano").
 */
function ingredientMatches(userIngNorm, recipeIngName) {
  const recipNorm = normalize(recipeIngName);
  return recipNorm.includes(userIngNorm) || userIngNorm.includes(recipNorm);
}

/**
 * Compute have / missing arrays and a match percentage for a recipe
 * given the user's ingredient list.
 */
function computeMatch(recipeIngredients, userIngredients) {
  const userNorm = userIngredients.map(normalize);

  const have    = [];
  const missing = [];

  recipeIngredients.forEach(ri => {
    const riName = ri.name || ri.originalName || '';
    const matched = userNorm.some(u => ingredientMatches(u, riName));
    if (matched) have.push(riName);
    else missing.push(riName);
  });

  const total      = have.length + missing.length;
  const matchPct   = total === 0 ? 0 : Math.round((have.length / total) * 100);

  return { have, missing, matchPercent: matchPct };
}

// ── API Routes ───────────────────────────────────────────────

/**
 * GET /api/recipes?ingredients=tomate,huevo,queso
 * Returns recipes matched and annotated with have/missing info.
 */
app.get('/api/recipes', async (req, res) => {

  // 1. Validate input
  const rawIngredients = req.query.ingredients;
  if (!rawIngredients || !rawIngredients.trim()) {
    return res.status(400).json({ error: true, message: 'Parámetro "ingredients" requerido.' });
  }

  // Parse and sanitize ingredient list
  const userIngredients = rawIngredients
    .split(',')
    .map(i => i.trim())
    .filter(i => i.length > 0 && i.length < 80)
    .slice(0, 30); // max 30 ingredients

  if (userIngredients.length === 0) {
    return res.status(400).json({ error: true, message: 'Lista de ingredientes vacía.' });
  }

  // 2. Check API key
  if (!SPOONACULAR_KEY) {
    return res.status(500).json({
      error: true,
      message: 'API Key no configurada. Agrega SPOONACULAR_API_KEY en el archivo .env'
    });
  }

  try {
    // 3. Call Spoonacular — findByIngredients
    //    Docs: https://spoonacular.com/food-api/docs#Search-Recipes-by-Ingredients
    const byIngredientsRes = await axios.get(`${SPOONACULAR_BASE}/recipes/findByIngredients`, {
      params: {
        apiKey:         SPOONACULAR_KEY,
        ingredients:    userIngredients.join(','),
        number:         MAX_RECIPES,
        ranking:        2,        // 2 = maximize used ingredients
        ignorePantry:   true,
        limitLicense:   false,
      },
      timeout: 10000,
    });

    const rawRecipes = byIngredientsRes.data;

    if (!rawRecipes || rawRecipes.length === 0) {
      return res.json({ recipes: [] });
    }

    // 4. Enrich each recipe with full ingredient detail
    //    We use Spoonacular's bulk info endpoint to get one call for all recipes
    const ids = rawRecipes.map(r => r.id).join(',');

    const bulkRes = await axios.get(`${SPOONACULAR_BASE}/recipes/informationBulk`, {
      params: {
        apiKey:              SPOONACULAR_KEY,
        ids,
        includeNutrition:    false,
      },
      timeout: 12000,
    });

    const detailMap = {};
    (bulkRes.data || []).forEach(d => { detailMap[d.id] = d; });

    // 5. Build annotated recipe list
    const recipes = rawRecipes.map(r => {
      const detail = detailMap[r.id] || {};
      const allIngredients = detail.extendedIngredients || [];

      // Use our own normalizer for accurate matching
      const { have, missing, matchPercent } = computeMatch(allIngredients, userIngredients);

      return {
        id:          r.id,
        title:       r.title,
        image:       r.image || detail.image || null,
        sourceUrl:   detail.sourceUrl || null,
        have,
        missing,
        matchPercent,
        // raw Spoonacular counts for reference
        usedCount:   r.usedIngredientCount,
        missedCount: r.missedIngredientCount,
      };
    });

    // 6. Sort by match percent descending (client can re-sort)
    recipes.sort((a, b) => b.matchPercent - a.matchPercent);

    return res.json({ recipes });

  } catch (err) {
    console.error('[Spoonacular Error]', err.message);

    // Distinguish quota / auth errors
    if (err.response) {
      const status = err.response.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({ error: true, message: 'API Key inválida o sin permisos.' });
      }
      if (status === 402) {
        return res.status(502).json({ error: true, message: 'Límite diario de la API de Spoonacular alcanzado.' });
      }
    }

    return res.status(502).json({
      error:   true,
      message: 'Error al comunicarse con Spoonacular. Revisá tu conexión o la API Key.',
    });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    keyConfigured: !!SPOONACULAR_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: true, message: 'Ruta no encontrada.' }));

// ── Error handler ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: true, message: 'Error interno del servidor.' });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍳 FridgeChef API corriendo en http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  if (!SPOONACULAR_KEY) {
    console.warn('\n⚠️  ADVERTENCIA: SPOONACULAR_API_KEY no está configurada en .env');
    console.warn('   Obtené una clave gratuita en https://spoonacular.com/food-api\n');
  }
});
