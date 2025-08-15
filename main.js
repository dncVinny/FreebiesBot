require('dotenv').config()
const axios = require('axios')
const cheerio = require('cheerio')
const fs = require('fs')
const path = require('path')

const STEAM_FREE_SEARCH_URL = 'https://store.steampowered.com/search/?sort_by=Price_ASC&maxprice=free&specials=1&ndl=1'
const STATE_FILE = path.join(process.cwd(), 'notified.json')

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
}

function to_unix_seconds(date) {
  return Math.floor(date.getTime() / 1000)
}

function chunk_array(input_array, size) {
  const chunks = []
  for (let i = 0; i < input_array.length; i += size) {
    chunks.push(input_array.slice(i, i + size))
  }
  return chunks
}

// Load saved state
function load_state() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && typeof parsed.notified_keys === 'object') {
        return parsed
      }
    }
  } catch (_) {}
  return { notified_keys: {} }
}

function save_state(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  } catch (error) {
    console.error('Failed to persist state:', error.message)
  }
}

function derive_item_key(item) {
  if (item.source === 'Steam') {
    const match = /\/app\/(\d+)/.exec(item.url || '')
    if (match && match[1]) return `steam_app_${match[1]}`
  }
  return `${item.source}:${item.url}`
}

function filter_new_items(items, state) {
  const new_items = []
  for (const item of items) {
    const key = derive_item_key(item)
    if (!state.notified_keys[key]) {
      new_items.push({ ...item, internal_key: key })
    }
  }
  return new_items
}

async function fetch_html(url) {
  const response = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 20000 })
  return response.data
}

// Fetch current Epic freebies from the backend API. Fails soft and returns [] on error.
async function fetch_epic_freebies() {
  try {
    const apiUrl = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US'
    const response = await axios.get(apiUrl, {
      timeout: 20000,
      headers: {
        ...DEFAULT_HEADERS,
        Accept: 'application/json'
      }
    })
    const data = response.data
    const now = new Date()

    const offers = data?.data?.Catalog?.searchStore?.elements || []
    const results = []

  for (const offer of offers) {
    const title = offer.title || 'Unknown Title'
    const productSlug = offer.productSlug || ''
    const mappings = offer.catalogNs?.mappings || []
    const keyImages = offer.keyImages || []
    const promotions = offer.promotions || {}

    const current = Array.isArray(promotions.promotionalOffers)
      ? promotions.promotionalOffers.flatMap(p => p.promotionalOffers || [])
      : []

    const active = current.find(p => {
      const start = p.startDate ? new Date(p.startDate) : null
      const end = p.endDate ? new Date(p.endDate) : null
      const discount = p.discountSetting?.discountPercentage
      return start && end && now >= start && now < end && Number(discount) === 0
    })

    if (!active) continue

    let pageSlug = null
    if (productSlug && productSlug.startsWith('p/')) {
      pageSlug = productSlug.replace(/^p\//, '')
    } else {
      const mapping = mappings.find(m => m.pageType === 'productHome' && m.pageSlug)
      if (mapping) pageSlug = mapping.pageSlug
    }
    if (!pageSlug) continue
    const url = `https://store.epicgames.com/en-US/p/${pageSlug}`

    const preferredTypes = [
      'DieselStoreFrontWide',
      'OfferImageWide',
      'OfferImageTall',
      'DieselStoreFrontTall'
    ]
    let imageUrl = null
    for (const t of preferredTypes) {
      const hit = keyImages.find(k => k.type === t && k.url)
      if (hit) { imageUrl = hit.url; break }
    }
    if (!imageUrl) {
      const nonThumb = keyImages.find(k => k.type !== 'Thumbnail' && k.url)
      imageUrl = nonThumb?.url || keyImages[0]?.url || null
    }

    const endsAt = active.endDate ? new Date(active.endDate) : null

    results.push({
      source: 'Epic Games',
      title,
      url,
      image_url: imageUrl,
      price_text: 'Free',
      ends_at: endsAt
    })
  }

    const uniqueByUrl = new Map(results.map(r => [r.url, r]))
    return Array.from(uniqueByUrl.values())
  } catch (e) {
    console.error('Error fetching Epic freebies:', e.message)
    return []
  }
}

//

// Fetch Steam search results and extract 100% off items
async function fetch_steam_freebies() {
  let html
  try {
    html = await fetch_html(STEAM_FREE_SEARCH_URL)
    const $ = cheerio.load(html)
    const results = []
    const rows = $('#search_resultsRows a.search_result_row')
    rows.each((_, element) => {
      const anchor = $(element)
      const url = anchor.attr('href')
      if (!url) return
      const title = anchor.find('.search_name .title').first().text().trim() || 'Unknown Title'
      const image_url = anchor.find('.search_capsule img').attr('src') || null
      const final_price_text = anchor.find('.discount_final_price').first().text().trim()
      const raw_price = final_price_text || anchor.find('.col.search_price').first().text().trim().replace(/\s+/g, ' ')
      const data_price_final = anchor.closest('[data-price-final]').attr('data-price-final')
      const price_text = (raw_price === '$0.00' || raw_price === '0' || data_price_final === '0') ? 'Free' : (raw_price || 'Free')
      results.push({ source: 'Steam', title, url, image_url, price_text, ends_at: null })
    })
    return results
  } catch (e) {
    console.error('Error fetching Steam freebies:', e.message)
    return []
  }
}

// Build Discord embed objects from internal item representation
function build_discord_embeds(items) {
  return items.map(item => {
    const fields = [
      { name: 'Price', value: item.price_text || 'Free', inline: false }
    ]

    if (item.ends_at instanceof Date && !isNaN(item.ends_at)) {
      const unix = to_unix_seconds(item.ends_at)
      fields.push({ name: 'Ends', value: `<t:${unix}:F> (<t:${unix}:R>)`, inline: false })
    }

    const base = {
      title: item.title,
      url: item.url,
      color: item.source === 'Epic Games' ? 16753920 : 3447003,
      footer: { text: item.source },
      fields
    }
    if (item.image_url) {
      if (item.source === 'Epic Games') {
        base.image = { url: item.image_url }
      } else {
        base.thumbnail = { url: item.image_url }
      }
    }
    return base
  })
}

// Send embeds to Discord in batches of 10 (discords limit)
async function send_discord_embeds(webhook_url, embeds, mention_role_id) {
  if (!embeds.length) return { delivered: 0 }

  const batches = chunk_array(embeds, 10)
  let delivered = 0

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const body = { embeds: batch }
    if (mention_role_id && i === 0) {
      body.content = `<@&${mention_role_id}>`
      body.allowed_mentions = { roles: [String(mention_role_id)] }
    }
    await axios.post(webhook_url, body, { headers: { 'Content-Type': 'application/json' } })
    delivered += batch.length
  }

  return { delivered }
}

async function main() {
  const webhook_url = process.env.DISCORD_WEBHOOK_URL
  const notify_role_id = process.env.NOTIFY_ROLE
  const interval_hours = Number(process.env.CHECK_INTERVAL_HOURS || 6)
  const interval_ms = Math.max(1, interval_hours) * 60 * 60 * 1000

  if (!webhook_url) {
    console.error('DISCORD_WEBHOOK_URL is not set. Create a .env file with DISCORD_WEBHOOK_URL=your_webhook_url')
    process.exit(1)
  }

  // One scan + notify cycle
  async function run_once() {
    try {
      const state = load_state()
      const [epic_items, steam_items] = await Promise.all([
        fetch_epic_freebies(),
        fetch_steam_freebies()
      ])

      const items = [
        ...epic_items,
        ...steam_items
      ]

      const new_items = filter_new_items(items, state)
      if (new_items.length === 0) {
        console.log('No free games found at this time.')
        return
      }

      const embeds = build_discord_embeds(new_items)

      const result = await send_discord_embeds(webhook_url, embeds, notify_role_id)
      for (const item of new_items) {
        if (item.internal_key) state.notified_keys[item.internal_key] = { notified_at: new Date().toISOString() }
      }
      save_state(state)
      console.log(`Sent ${result.delivered} embed(s) to Discord.`)
    } catch (error) {
      console.error('Error during check:', error.message)
    }
  }

  // Prevent overlapping runs 
  let is_running = false
  const run_safely = async () => {
    if (is_running) {
      console.log('Previous check still running; make sure you CHECK_INTERVAL_HOURS is set to a value greater than 0')
      return
    }
    is_running = true
    try { await run_once() } finally { is_running = false }
  }

  await run_safely()
  console.log(`Next checks every ${interval_hours} hour(s).`)
  setInterval(run_safely, interval_ms)
}

main()
