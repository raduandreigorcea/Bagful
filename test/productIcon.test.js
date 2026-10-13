import { describe, it, expect } from 'vitest'
import { getProductIcon } from '../src/lib/productIcon'

describe('getProductIcon', () => {
  it('maps known products to their emoji', () => {
    expect(getProductIcon('milk')).toBe('milk')
    expect(getProductIcon('apple')).toBe('apple')
    expect(getProductIcon('grapes')).toBe('grapes')
    expect(getProductIcon('coconut')).toBe('coconut')
  })

  it('is case-insensitive', () => {
    expect(getProductIcon('MILK')).toBe('milk')
    expect(getProductIcon('Grapes')).toBe('grapes')
  })

  it('ignores diacritics', () => {
    // normalizeText strips combining marks, so "Bánana" resolves to "banana".
    expect(getProductIcon('Bánana')).toBe('banana')
    expect(getProductIcon('Apă Plată 2L')).toBe('water')
  })

  it('matches a keyword anywhere in the name', () => {
    expect(getProductIcon('whole milk')).toBe('milk')
    expect(getProductIcon('Lapte 3.5% 1L')).toBe('milk')
  })

  it('falls back to the default bag emoji when nothing matches', () => {
    expect(getProductIcon('asdfqwer')).toBe('generic')
    expect(getProductIcon('')).toBe('generic')
  })
})

// Keywords match whole words only. Every case here really did fire before, and
// a short keyword hiding inside a longer word is the failure mode that returns
// the moment someone adds a three-letter keyword without thinking.
describe('whole-word matching', () => {
  it('does not let "mar" (apple) match inside a longer word', () => {
    expect(getProductIcon('Margarina 250g', 'Rama')).toBe('butter')
    expect(getProductIcon('Marar Legatura')).toBe('herbs')
    expect(getProductIcon('Marmelada')).not.toBe('apple')
  })

  it('does not let "apa" (water) match inside "ceapa" (onion)', () => {
    expect(getProductIcon('Ceapa Galbena 1kg')).toBe('onion')
  })

  it('does not let "vin" (wine) match inside "vinete" (aubergine)', () => {
    expect(getProductIcon('Vinete 1kg')).toBe('eggplant')
  })

  it('still matches a whole word at either end of the name', () => {
    expect(getProductIcon('Mere Golden 1kg')).toBe('apple')
    expect(getProductIcon('Suc de Mere')).toBe('apple')
  })
})

// The maker is part of the haystack, which is a feature — and was a liability
// while matching was substring-based.
describe('the maker', () => {
  it('does not poison the match with a brand that contains a keyword', () => {
    // "Margaritar" contains "mar", "Rio Mare" contains "mar", "Bunica"
    // contains "bun" — all three used to decide the emoji.
    expect(getProductIcon('Zahar Alb 1kg', 'Margaritar')).toBe('sugar')
    expect(getProductIcon('Ton in Ulei 185g', 'Rio Mare')).toBe('fish')
    expect(getProductIcon('Ulei de Floarea Soarelui 1L', 'Bunica')).toBe('sunflower-oil')
  })

  it('gives the same emoji to the same product whatever the brand', () => {
    expect(getProductIcon('Ton in Ulei 185g', 'Rio Mare')).toBe(
      getProductIcon('Ton in Suc Propriu 185g', 'Calvo'),
    )
  })

  it('still uses the maker when it is the only signal', () => {
    // Hazelnut spread is chocolate, and only "Nutella" says so.
    expect(getProductIcon('Crema de Alune 400g', 'Nutella')).toBe('chocolate')
  })
})

// The longest matching keyword wins, so a rule can be made more specific without
// caring where it sits in the list.
describe('specificity', () => {
  it('prefers the longer keyword over the shorter one it contains', () => {
    expect(getProductIcon('Apa Plata 2L', 'Dorna')).toBe('water')
    expect(getProductIcon('Apa de Gura 500ml', 'Listerine')).toBe('toothbrush')
  })

  it('separates plain sugar from vanilla sugar', () => {
    expect(getProductIcon('Zahar Alb 1kg')).toBe('sugar')
    expect(getProductIcon('Zahar Vanilat 8g', 'Dr. Oetker')).toBe('cupcake')
  })

  it('separates the oils', () => {
    expect(getProductIcon('Ulei de Masline Extravirgin 500ml', 'Monini')).toBe('olive-oil')
    expect(getProductIcon('Ulei de Floarea Soarelui 1L')).toBe('sunflower-oil')
  })

  it('reads peanut butter as peanut rather than butter', () => {
    expect(getProductIcon('Unt 80% 200g', 'President')).toBe('butter')
    expect(getProductIcon('Unt de Arahide 350g')).toBe('nuts')
  })

  it('separates a fish tin in oil from the oil itself', () => {
    expect(getProductIcon('Ton in Ulei 185g')).toBe('fish')
  })

  // Unicode has no crisps. Before this split, a bag of Lay's and a kilo of
  // potatoes were the same icon, which is the one distinction a shopping list
  // actually needs to draw.
  it('tells a snack apart from the vegetable it is made of', () => {
    expect(getProductIcon('Chipsuri Sare 140g', "Lay's")).toBe('chips')
    expect(getProductIcon('Cartofi Albi 1kg')).toBe('potato')
    expect(getProductIcon('Cartofi Pai Congelati 750g', 'Aviko')).toBe('fries')
    expect(getProductIcon('Piure de Cartofi 125g', 'Maggi')).toBe('potato')
  })

  it('resolves an equal-length tie by rule order', () => {
    // "chipsuri" and "smantana" are both eight letters; the product is chips.
    expect(getProductIcon('Chipsuri cu Smantana si Verdeturi 140g', "Lay's")).toBe('chips')
    // "inghetata" and "ciocolata" are both nine; the product is ice cream.
    expect(getProductIcon('Inghetata cu Ciocolata 900ml', 'Betty Ice')).toBe('ice-cream')
  })
})

describe('coverage of the seeded catalog', () => {
  it('resolves the categories that used to fall through to the bag', () => {
    expect(getProductIcon('Cozonac cu Nuca 400g', 'Boromir')).toBe('cake')
    expect(getProductIcon('Chifle 6 buc')).toBe('bread')
    expect(getProductIcon('Mici Traditionali 440g', 'Cris-Tim')).toBe('skewer')
    expect(getProductIcon('Kaizer Afumat 200g', 'Fox')).toBe('bacon')
    expect(getProductIcon('Ketchup Dulce 500g', 'Tomi')).toBe('sauce')
    expect(getProductIcon('Inghetata de Vanilie 1L', 'Betty Ice')).toBe('ice-cream')
    expect(getProductIcon('Baterii AA 4 buc', 'Duracell')).toBe('battery')
    expect(getProductIcon('Becuri LED E27 3 buc', 'Philips')).toBe('light-bulb')
    expect(getProductIcon('Chibrituri 3 cutii')).toBe('matches')
    expect(getProductIcon('Absorbante 10 buc', 'Always')).toBe('sanitary')
    expect(getProductIcon('Batiste de Hartie 10 pachete', 'Zewa')).toBe('tissues')
    expect(getProductIcon('Cornflakes 500g', 'Nestle')).toBe('cereal')
  })

  it('does not read plums as olives', () => {
    expect(getProductIcon('Prune 1kg')).toBe('plum')
    expect(getProductIcon('Masline Verzi 200g')).toBe('olive')
  })

  it('keeps fruit juice fruity but does not call iced tea a fruit', () => {
    expect(getProductIcon('Suc de Portocale 1L', 'Cappy')).toBe('orange')
    expect(getProductIcon('Ice Tea Piersici 1.5L', 'Lipton')).toBe('soda')
  })
})

// Gaps the importer's coverage report found in real Open Food Facts products,
// which the curated 256 never happened to contain.
describe('coverage of imported products', () => {
  it('knows the products the first import surfaced', () => {
    expect(getProductIcon('Tofu Natur 200g', 'SanoVita')).toBe('beans')
    expect(getProductIcon('Originals: Skyr 100g', 'Schogetten')).toBe('yogurt')
    // Neither says "ceai" or "tea", so the existing keywords could not reach them.
    expect(getProductIcon('Earl Grey 100g', 'Twinings')).toBe('tea')
    expect(getProductIcon('Tea Lady Grey 100g', 'Twinings')).toBe('tea')
  })

  it('does not let the new keywords steal unrelated products', () => {
    expect(getProductIcon('Ceafa de Porc 1kg')).toBe('steak')
    expect(getProductIcon('Grey Goose 700ml')).toBe('generic')
  })
})

// Gaps the first Open Food Facts import surfaced: 202 of 3,329 imported
// products fell through to the shopping bag, and these were the words that
// covered the most shelf.
describe('keywords added from the import coverage report', () => {
  it('recognises the words the imported catalog brought in', () => {
    expect(getProductIcon('Oreo Original 154g')).toBe('cookie')
    expect(getProductIcon('Crackers cu Susan 100g')).toBe('cookie')
    expect(getProductIcon('Spaghete No. 5 500g')).toBe('pasta')
    expect(getProductIcon('Hummus Clasic 200g')).toBe('beans')
    expect(getProductIcon('Cuscus Integral 500g')).toBe('rice')
    expect(getProductIcon('Pateu de Ficat 200g')).toBe('canned')
    expect(getProductIcon('Vin Alb Feteasca Regala 750ml')).toBe('wine')
    expect(getProductIcon('Cafea Lungo 10 buc')).toBe('coffee')
    expect(getProductIcon('Actimel Natural 100ml')).toBe('yogurt')
    expect(getProductIcon('Vitamin D3 5000 Iu')).toBe('pills')
  })

  // Longest-keyword-wins means a broad new word can outrank a precise old one.
  // The report suggested 'protein', which is longer than 'iaurt' and would have
  // turned every protein yogurt into a pill. It was left out for that reason.
  it('does not let the new keywords outrank a more precise one', () => {
    expect(getProductIcon('Iaurt Proteic 400g')).toBe('yogurt')
    expect(getProductIcon('Branza Philadelphia 175g')).toBe('cheese')
    expect(getProductIcon('Suc de Portocale 1L')).toBe('orange')
  })
})

// Some products name a brand and a flavour and nothing else. "Pringles Sour
// Cream & Onion" is crisps, but "sour cream" is the longer keyword, so before
// brands were given their own tier it rendered as dairy.
describe('brands that are a category', () => {
  it('reads the brand when the name says nothing about the product', () => {
    expect(getProductIcon('Original 165g', 'Pringles')).toBe('chips')
    expect(getProductIcon('Original 100g', 'Chio')).toBe('chips')
    expect(getProductIcon('Eugenia 36g', 'Dobrogea')).toBe('cookie')
    expect(getProductIcon('Mountain Dew 330ml', 'Mountain Dew')).toBe('soda')
    expect(getProductIcon('Activia Fibre 100g', 'Danone')).toBe('yogurt')
    expect(getProductIcon('Dark Intense 80g', 'Heidi')).toBe('chocolate')
  })

  it('beats a longer flavour word, which is what length alone got wrong', () => {
    expect(getProductIcon('Sour Cream & Onion 165g', 'Pringles')).toBe('chips')
    expect(getProductIcon('Sare 140g', "Lay's")).toBe('chips')
    expect(getProductIcon('Nachos Cheese 100g', 'Doritos')).toBe('chips')
  })

  // A retailer sells everything, so its name can never imply a category.
  it('ignores retailers and leaves the keywords in charge', () => {
    expect(getProductIcon('Paine Alba Feliata 500g', 'Carrefour')).toBe('bread')
    expect(getProductIcon('Lapte 3.5% 1L', 'Lidl')).toBe('milk')
  })

  // Juice brands are deliberately absent: the fruit is the nicer icon and the
  // keyword table already picks it.
  it('does not let a brand tier override the fruit in a juice', () => {
    expect(getProductIcon('Suc de Portocale 1L', 'Santal')).toBe('orange')
  })
})

// A modifier that happens to be longer than the head noun used to win.
describe('the head noun beats a longer modifier', () => {
  it('picks the product, not the thing it is flavoured with', () => {
    expect(getProductIcon('Tortilla Chips Nacho 100g', 'Doritos')).toBe('chips')
    expect(getProductIcon('Pate de Porc 120g', 'Cris Tim')).toBe('canned')
    expect(getProductIcon('Crema de Hrean 200g', 'Raureni')).toBe('canned')
    expect(getProductIcon('Salata de Icre de Crap 100g', 'Gusturi Romanesti')).toBe('fish')
  })

  it('leaves the deliberate ties alone', () => {
    // Both called out inline in productIcon.ts as depending on rule order.
    expect(getProductIcon('Chipsuri cu Smantana 140g')).toBe('chips')
    expect(getProductIcon('Inghetata cu Ciocolata 110g')).toBe('ice-cream')
    expect(getProductIcon('Apa de Gura 500ml', 'Colgate')).toBe('toothbrush')
  })
})

describe('memoization', () => {
  it('returns a stable answer for a repeated product', () => {
    const first = getProductIcon('Apa Plata 2L', 'Dorna')
    const second = getProductIcon('Apa Plata 2L', 'Dorna')
    expect(second).toBe(first)
  })

  it('does not confuse two products that differ only by maker', () => {
    expect(getProductIcon('Crema de Alune 400g', 'Nutella')).toBe('chocolate')
    expect(getProductIcon('Crema de Maini 100ml', 'Nivea')).toBe('shampoo')
  })

  it('gives every sauce the one bottle, and mayonnaise its jar', () => {
    for (const name of ['Sos de usturoi', 'Garlic sauce', 'Ketchup Dulce 500g', 'Mustar Dijon 200g', 'Sos BBQ 250ml', 'Sos de rosii pentru paste']) {
      expect(getProductIcon(name)).toBe('sauce')
    }
    expect(getProductIcon('Maioneza')).toBe('mayonnaise')
  })

  it('lets the first word name the product, not the flavour after it', () => {
    const cases = {
      'Gem capsuni Dalfour, 284g': 'jam',
      'Cereale Nesquik': 'cereal',
      'Chifle cu seminte': 'bread',
      'Cornuri cu ciocolata': 'croissant',
      'Chec cu cacao': 'cake',
      'Tort de ciocolata': 'cake',
      'Sos de maioneza Hellmann\'s': 'mayonnaise',
      'Apa de gura Listerine': 'toothbrush',
    }
    for (const [name, icon] of Object.entries(cases)) expect(getProductIcon(name)).toBe(icon)
  })

  it('knows plant milks, dish detergent, vodka and sunflower seeds', () => {
    expect(getProductIcon('Lapte de migdale Alpro')).toBe('milk')
    expect(getProductIcon('Detergent vase Fairy')).toBe('dishwashing')
    expect(getProductIcon('Vodca Absolut')).toBe('spirits')
    expect(getProductIcon('Seminte de floarea soarelui')).toBe('nuts')
  })

  it('fixes found by reading real catalog names', () => {
    const cases = {
      'Papel higiénico foxy cotton 5 capas': 'toilet-paper',
      'Papel vegetal para hornear': 'cupcake',
      'Servetele faciale Oti': 'tissues',
      'Apa micelara Elmiplant': 'soap',
      'Salam de biscuiti Auchan': 'cookie',
      'Chicles sabor fresa sin azúcar': 'candy',
      'Heinz Baked Beans': 'beans',
      'Ulei Spray Protector Elmiplant Spf30': 'sunscreen',
      'Seminte floarea soarelui pestrite': 'nuts',
      'Biscuiti pentru caini': 'dog-food',
      'Mezeluri salam de sibiu': 'sandwich',
    }
    for (const [name, icon] of Object.entries(cases)) expect(getProductIcon(name)).toBe(icon)
  })

  it('fixes found by reading the popular catalog products', () => {
    const cases = {
      'Telemea de capra Olympus, 350 g': 'cheese',
      'Deodorant stick Dove Raspberry & Rose, 75 ml': 'shampoo',
      'Deodorant stick Dove Lavender & Chamomile, 75 ml': 'shampoo',
      'Sampon uscat Tropical Batiste, 200 ml': 'shampoo',
      'Salata de ton Mexico Kaiser Franz Josef, 160 g': 'fish',
      'KFC Sos cu usturoi': 'sauce',
      'Sos de ardei iute verde Tabasco 60 ml': 'sauce',
    }
    for (const [name, icon] of Object.entries(cases)) expect(getProductIcon(name)).toBe(icon)
  })
})
