function normalizeTaxonomyTree(data) {
  return Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
}

export function flattenTaxonomyTree(nodes = [], path = [], result = []) {
  for (const node of nodes || []) {
    const fullPath = [...path, node.name];
    result.push({
      id: node.id,
      name: node.name,
      path: fullPath,
      label: fullPath.join(' › '),
      level: path.length,
    });
    if (node.children?.length) flattenTaxonomyTree(node.children, fullPath, result);
  }
  return result;
}

export function createTaxonomyCatalog({ loadTaxonomy } = {}) {
  if (typeof loadTaxonomy !== 'function') throw new TypeError('loadTaxonomy function is required');
  let loaded = false;
  let loadPromise = null;
  let flatList = [];

  async function load() {
    if (loaded) return flatList;
    if (!loadPromise) {
      loadPromise = Promise.resolve(loadTaxonomy())
        .then(data => {
          flatList = flattenTaxonomyTree(normalizeTaxonomyTree(data), [], []);
          loaded = true;
          return flatList;
        })
        .catch(error => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  }

  function initial(limit = 200) {
    return flatList.slice(0, limit);
  }

  function search(query, limit = 100) {
    const normalized = String(query || '').toLowerCase();
    if (!normalized) return initial(200);
    return flatList
      .filter(node => node.label.toLowerCase().includes(normalized))
      .slice(0, limit);
  }

  function findById(id) {
    return flatList.find(node => node.id === id) || null;
  }

  function findBest(hint) {
    if (!hint || !flatList.length) return null;
    const words = String(hint).toLowerCase()
      .replace(/[>\/>\u203a,|]+/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2);
    if (!words.length) return null;

    const scored = flatList
      .map(node => {
        const label = node.label.toLowerCase();
        const matches = words.filter(word => label.includes(word)).length;
        return { node, score: matches * 10 + node.level };
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.node || null;
  }

  return {
    load,
    initial,
    search,
    findById,
    findBest,
  };
}

export const taxonomyCatalog = createTaxonomyCatalog({
  loadTaxonomy: async () => {
    const { etsy } = await import('../utils/api.js');
    return etsy.getTaxonomy();
  },
});
