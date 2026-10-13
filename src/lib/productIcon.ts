// Pick an icon for a product from its name and maker.
//
// Two rules make this safe to extend:
//
// 1. Keywords match WHOLE WORDS, never substrings. "mar" (apple) must not match
//    "Margarina", "Marar" (dill), or the maker "Margaritar"; "bun" (bread roll)
//    must not match the maker "Bunica". All of those really did fire before.
//
// 2. The LONGEST matching keyword wins, so specificity beats position in this
//    list: "apa de gura" (mouthwash) outranks "apa" (water) no matter where its
//    rule sits. Equal-length keywords fall back to the order below — the few
//    places that relies on are called out inline.
//
// The maker is part of the haystack on purpose: sometimes it is the only signal
// ("Crema de Alune · Nutella" is chocolate, not peanuts). Whole-word matching is
// what makes that affordable.
//
// Romanian is inflected and matching is whole-word, so plurals and variants must
// be listed explicitly ("chifla" does not match "chifle").
const ICON_RULES = [
  // ─── Fruit ─────────────────────────────────────────────────────────────────
  { icon: 'apple', keywords: ['mar', 'mere', 'apple', 'apples', 'gutui', 'gutuie', 'quince'] },
  { icon: 'pear', keywords: ['para', 'pere', 'pear', 'pears'] },
  { icon: 'banana', keywords: ['banana', 'banane'] },
  { icon: 'orange', keywords: ['portocala', 'portocale', 'orange', 'oranges', 'mandarina', 'mandarine', 'clementina', 'clementine', 'tangerine'] },
  { icon: 'lemon', keywords: ['lamaie', 'lamai', 'lemon', 'lemons', 'lime', 'lime uri'] },
  { icon: 'watermelon', keywords: ['pepene', 'pepene verde', 'watermelon', 'harbuz'] },
  { icon: 'melon', keywords: ['pepene galben', 'melon', 'cantaloupe'] },
  { icon: 'pineapple', keywords: ['ananas', 'pineapple'] },
  { icon: 'kiwi', keywords: ['kiwi'] },
  { icon: 'mango', keywords: ['mango', 'papaya'] },
  // Unicode has no plum or apricot; the peach stands in for the whole stone-fruit
  // household, as it did before.
  { icon: 'peach', keywords: ['piersica', 'piersici', 'peach', 'peaches', 'nectarina', 'nectarine'] },
  { icon: 'apricot', keywords: ['caisa', 'caise', 'apricot', 'apricots'] },
  { icon: 'plum', keywords: ['pruna', 'prune', 'plum', 'plums'] },
  { icon: 'cherry', keywords: ['cirese', 'cireasa', 'cherry', 'cherries', 'visine', 'visina'] },
  { icon: 'strawberry', keywords: ['capsuna', 'capsuni', 'strawberry', 'strawberries', 'fragi', 'zmeura', 'raspberry'] },
  { icon: 'blueberry', keywords: ['afine', 'goji', 'blueberry', 'blueberries', 'mure', 'blackberry', 'coacaze', 'currants', 'fructe de padure', 'forest fruits'] },
  // Dried fruit rides along with grapes: raisins are grapes, and figs and dates
  // have no emoji of their own.
  { icon: 'grapes', keywords: ['struguri', 'grape', 'grapes', 'stafide', 'raisins', 'smochine', 'figs', 'curmale', 'dates'] },
  { icon: 'coconut', keywords: ['cocos', 'coconut'] },
  { icon: 'avocado', keywords: ['avocado'] },

  // ─── Dairy & eggs ──────────────────────────────────────────────────────────
  { icon: 'egg', keywords: ['eier', 'uova', 'oeufs', 'huevos', 'eieren', 'ou', 'oua', 'egg', 'eggs'] },
  { icon: 'yogurt', keywords: ['joghurt', 'yaourt', 'iaurt', 'yogurt', 'yoghurt', 'skyr', 'actimel'] },
  { icon: 'milk', keywords: ['milch', 'latte', 'lait', 'leche', 'melk', 'lapte de migdale', 'lapte de ovaz', 'lapte de soia', 'lapte de cocos', 'lapte de orez', 'bautura din ovaz', 'bautura din soia', 'bautura din migdale', 'bautura din orez', 'bautura din cocos', 'lapte', 'milk', 'chefir', 'kefir', 'sana', 'lapte batut', 'lapte vegetal', 'bautura vegetala', 'bautura de ovaz', 'bautura de soia', 'bautura de orez', 'bautura de migdale', 'oat drink', 'soy drink', 'rice drink', 'almond drink'] },
  { icon: 'cheese', keywords: ['kase', 'formaggio', 'fromage', 'queso', 'kaas', 'branza', 'cascaval', 'telemea', 'cheese', 'mozzarella', 'parmezan', 'parmesan', 'gouda', 'cheddar', 'emmental', 'feta', 'ricotta', 'burduf', 'brie', 'camembert', 'urda', 'philadelphia'] },
  { icon: 'butter', keywords: ['burro', 'beurre', 'mantequilla', 'boter', 'unt', 'butter', 'margarina', 'margarine', 'rama'] },

  // ─── Snacks ────────────────────────────────────────────────────────────────
  // Before the dairy rule below: "Chipsuri cu Smantana" ties on length between
  // "chipsuri" and "smantana", and chips is the product.
  //
  // Fries rather than a potato: Unicode has no crisps, and a raw potato is what
  // the vegetable rule already uses -- a bag of Lay's and a kilo of cartofi were
  // the same icon in the list. Fried potato is at least the right meal.
  { icon: 'chips', keywords: ['chips paprika', 'chipsuri paprika', 'chipsuri', 'chips', 'crisps', 'tortilla chips', 'nachos chips'] },
  { icon: 'fries', keywords: ['fries', 'french fries', 'cartofi pai', 'cartofi prajiti'] },
  { icon: 'milk', keywords: ['smantana', 'sour cream', 'crema de gatit', 'cooking cream', 'frisca', 'whipping cream'] },
  // Before the chocolate rule: "Inghetata cu Ciocolata" ties on length and the
  // product is ice cream.
  { icon: 'ice-cream', keywords: ['inghetata', 'ice cream', 'gelato'] },

  // ─── Bakery ────────────────────────────────────────────────────────────────
  { icon: 'bread', keywords: ['brot', 'pane', 'pain', 'brood', 'paine', 'bread', 'toast', 'painici', 'lipii', 'chifla', 'chifle', 'bun', 'buns', 'franzela', 'lipie', 'tortilla', 'lavash', 'pesmet', 'breadcrumbs'] },
  { icon: 'baguette', keywords: ['bagheta', 'baguette'] },
  { icon: 'croissant', keywords: ['croissant', 'croisant', 'cornuri', 'cornulete', 'foietaj', 'puff pastry', 'aluat'] },
  { icon: 'pretzel', keywords: ['pretzel', 'covrig', 'covrigi', 'covrigei', 'sticksuri', 'grisine'] },
  { icon: 'cookie', keywords: ['salam de biscuiti', 'biscuit', 'biscuiti', 'cookie', 'cookies', 'napolitane', 'wafer', 'wafers', 'oreo', 'crackers', 'petit beurre', 'turta dulce'] },
  { icon: 'cake', keywords: ['prajitura', 'cake', 'tort', 'desert', 'dessert', 'ecler', 'savarina', 'cheesecake', 'brownie', 'cozonac', 'chec', 'mucenici'] },
  { icon: 'cupcake', keywords: ['papel vegetal', 'papel de horno', 'hartie de copt', 'baking paper', 'esenta de rom', 'esenta de vanilie', 'esenta de portocale', 'esenta de lamaie', 'esenta de migdale', 'aroma de rom', 'muffin', 'briose', 'cupcake', 'drojdie', 'yeast', 'praf de copt', 'baking powder', 'zahar vanilat', 'bicarbonat'] },
  { icon: 'donut', keywords: ['donut', 'donuts', 'gogosi', 'gogoasa'] },
  { icon: 'pie', keywords: ['placinta', 'pie', 'strudel', 'tarta', 'tarte'] },

  // ─── Sweets ────────────────────────────────────────────────────────────────
  { icon: 'chocolate', keywords: ['chocolade', 'schokolade', 'schoko', 'cioccolato', 'chocolat', 'ciocolata', 'chocolate', 'cacao', 'nutella', 'crema de alune', 'kinder', 'nesquik'] },
  { icon: 'candy', keywords: ['chicles', 'bomboane', 'candy', 'candies', 'jeleuri', 'jelly', 'lollipop', 'acadea', 'guma', 'guma de mestecat', 'chewing gum', 'halva', 'gelatina', 'fudge'] },
  { icon: 'sugar', keywords: ['zahar', 'sugar', 'zucker', 'zucchero', 'sucre', 'azucar', 'suiker', 'zahar cu scortisoara'] },
  { icon: 'honey', keywords: ['miere', 'honey', 'sirop', 'syrup'] },
  { icon: 'jam', keywords: ['gem', 'dulceata', 'jam', 'marmalade', 'confiture', 'marmellata', 'mermelada', 'konfituere'] },
  { icon: 'popcorn', keywords: ['popcorn', 'pufuleti'] },
  { icon: 'nuts', keywords: ['alune', 'arahide', 'peanuts', 'nuci', 'nuca', 'nuts', 'caju', 'cashews', 'migdale', 'almonds', 'fistic', 'pistachio', 'seminte', 'seminte de floarea soarelui', 'seeds', 'susan', 'sesame', 'unt de arahide', 'peanut butter'] },

  // ─── Meat & fish ───────────────────────────────────────────────────────────
  { icon: 'canned', keywords: ['conserva', 'conserve', 'canned', 'borcan', 'jar', 'pate', 'pateu', 'pate de porc', 'pate de pui', 'crema de hrean', 'zacusca', 'compot'] },
  { icon: 'bacon', keywords: ['bacon', 'slanina', 'kaiser', 'kaizer', 'pancetta'] },
  { icon: 'chicken', keywords: ['pollo', 'poulet', 'hahnchen', 'huhn', 'kip', 'pui', 'chicken', 'curcan', 'turkey', 'pulpe', 'aripioare', 'wings'] },
  { icon: 'steak', keywords: ['schwein', 'maiale', 'rind', 'manzo', 'boeuf', 'vita', 'beef', 'porc', 'pork', 'miel', 'lamb', 'carne', 'carne tocata', 'minced meat', 'cotlet', 'ceafa', 'muschi', 'snitel'] },
  { icon: 'sausage', keywords: ['wurst', 'salsiccia', 'saucisse', 'salchicha', 'worst', 'carnati', 'sausage', 'sausages', 'crenvursti', 'hot dog', 'cabanos'] },
  { icon: 'ribs', keywords: ['coaste', 'ribs', 'ciolan', 'jambon'] },
  { icon: 'skewer', keywords: ['mici', 'mititei', 'frigarui', 'skewer', 'kebab'] },
  { icon: 'burger', keywords: ['burger', 'hamburger', 'meatballs', 'chiftele'] },
  { icon: 'sandwich', keywords: ['sunca', 'ham', 'prosciutto', 'pastrama', 'mortadella', 'parizer', 'salam', 'sandwich'] },
  { icon: 'fish', keywords: ['salata de ton', 'fisch', 'pesce', 'poisson', 'pescado', 'sol mar', 'peste', 'fish', 'salata de icre', 'salata cu icre', 'somon', 'salmon', 'ton', 'ton in ulei', 'tuna', 'macrou', 'mackerel', 'pastrav', 'trout', 'sardine', 'hering', 'herring', 'cod', 'icre'] },
  { icon: 'shrimp', keywords: ['creveti', 'shrimp', 'prawns', 'fructe de mare', 'seafood', 'midii', 'mussels', 'calamari', 'squid', 'caracatita', 'octopus'] },

  // ─── Staples ───────────────────────────────────────────────────────────────
  { icon: 'pasta', keywords: ['nudeln', 'noedels', 'paste', 'pasta', 'spaghetti', 'penne', 'fusilli', 'tagliatelle', 'macaroane', 'lasagna', 'spaghete'] },
  { icon: 'noodles', keywords: ['taitei', 'noodles', 'supa instant', 'instant noodles', 'ramen'] },
  { icon: 'rice', keywords: ['reis', 'riso', 'riz', 'arroz', 'rijst', 'orez', 'rice', 'risotto', 'cous cous', 'cuscus', 'quinoa', 'bulgur'] },
  { icon: 'flour', keywords: ['mehl', 'farina', 'farine', 'harina', 'bloem', 'faina', 'flour', 'malai', 'cornmeal', 'gris', 'semolina'] },
  { icon: 'cereal', keywords: ['cereale', 'cereal', 'cornflakes', 'corn flakes', 'oat', 'ovaz', 'fulgi', 'musli', 'muzli', 'muesli', 'granola', 'terci', 'porridge'] },
  { icon: 'mayonnaise', keywords: ['maioneza', 'mayo', 'mayonnaise'] },
  // A sauce named after its flavour: the flavour word is longer than "sos" and
  // would win, filing garlic sauce under vegetables.
  { icon: 'sauce', keywords: ['sos', 'sos cu usturoi', 'sos de ardei', 'sos cu ardei', 'sauce', 'dressing', 'sos de usturoi', 'garlic sauce', 'ketchup', 'mustar', 'mustard', 'sos de rosii', 'sos de tomate', 'tomato sauce'] },
  { icon: 'beans', keywords: ['baked beans', 'fasole', 'beans', 'linte', 'lentils', 'naut', 'chickpeas', 'mazare', 'peas', 'tofu', 'chickpea', 'humus', 'hummus', 'soia', 'soia texturata', 'soy', 'textured soy'] },

  // ─── Vegetables ────────────────────────────────────────────────────────────
  { icon: 'potato', keywords: ['cartof', 'cartofi', 'potato', 'potatoes', 'piure', 'telina', 'celery root', 'pastarnac', 'parsnip'] },
  { icon: 'onion', keywords: ['ceapa', 'onion', 'onions', 'ceapa verde', 'green onion', 'praz', 'leek'] },
  { icon: 'garlic', keywords: ['usturoi', 'garlic'] },
  { icon: 'carrot', keywords: ['morcov', 'morcovi', 'carrot', 'carrots'] },
  { icon: 'beet', keywords: ['sfecla', 'beet', 'beets'] },
  { icon: 'radish', keywords: ['ridiche', 'ridichi', 'radish'] },
  { icon: 'tomato', keywords: ['rosii pasate', 'tomate pasate', 'rosie', 'rosii', 'tomato', 'tomatoes', 'bulion', 'passata', 'pasta de tomate', 'tomate'] },
  { icon: 'cucumber', keywords: ['castravete', 'castraveti', 'cucumber', 'cucumbers', 'cornichon', 'muraturi'] },
  { icon: 'zucchini', keywords: ['dovlecel', 'dovlecei', 'zucchini'] },
  { icon: 'eggplant', keywords: ['vinete', 'eggplant', 'aubergine'] },
  { icon: 'lettuce', keywords: ['salata', 'lettuce', 'spanac', 'spinach', 'kale', 'rucola', 'arugula'] },
  { icon: 'cabbage', keywords: ['varza', 'cabbage'] },
  { icon: 'broccoli', keywords: ['broccoli', 'conopida', 'cauliflower'] },
  { icon: 'corn', keywords: ['porumb', 'corn'] },
  { icon: 'mushroom', keywords: ['ciuperci', 'ciuperca', 'mushroom', 'mushrooms', 'champignon'] },
  { icon: 'pepper', keywords: ['ardei', 'pepper', 'peppers', 'kapia', 'gogosar', 'gogosari', 'chili'] },
  { icon: 'pumpkin', keywords: ['dovleac', 'pumpkin'] },
  { icon: 'salad', keywords: ['legume', 'vegetables', 'mixed veg'] },
  { icon: 'herbs', keywords: ['patrunjel', 'parsley', 'marar', 'dill', 'leustean', 'tarhon', 'tarragon', 'rozmarin', 'rosemary', 'menta', 'mint', 'salvie', 'sage'] },

  // ─── Oil, vinegar, seasoning ───────────────────────────────────────────────
  { icon: 'olive', keywords: ['oliva', 'masline', 'olive', 'olives'] },
  { icon: 'sunflower-oil', keywords: ['ulei de floarea soarelui', 'sunflower oil', 'floarea soarelui'] },
  { icon: 'olive-oil', keywords: ['ulei de masline', 'olive oil', 'olivenol', 'olio extravergine', 'huile d olive', 'ulei', 'oil', 'otet', 'otet de mere', 'vinegar', 'sos de soia', 'soy sauce'] },
  { icon: 'salt', keywords: ['sare', 'salt', 'condiment', 'condimente', 'spice', 'spices', 'piper', 'pepper corns', 'boia', 'paprika', 'oregano', 'busuioc', 'cimbru', 'thyme', 'curry', 'scortisoara', 'cinnamon', 'vegeta', 'baza pentru mancaruri', 'stock cube', 'cub'] },

  // ─── Prepared ──────────────────────────────────────────────────────────────
  { icon: 'pizza', keywords: ['pizza', 'focaccia'] },
  { icon: 'taco', keywords: ['taco', 'tacos', 'nachos', 'quesadilla', 'burrito'] },
  { icon: 'dumpling', keywords: ['coltunasi', 'dumplings', 'pelmeni', 'gyoza', 'ravioli', 'tortellini', 'sarmale'] },
  { icon: 'soup', keywords: ['ciorba', 'soup', 'supa', 'stew', 'tocanita', 'tocana', 'bors'] },
  { icon: 'fried-egg', keywords: ['omleta', 'omelette', 'mic dejun', 'breakfast'] },

  // ─── Drinks ────────────────────────────────────────────────────────────────
  { icon: 'water', keywords: ['wasser', 'acqua', 'eau', 'agua', 'apa', 'water', 'apa plata', 'apa minerala', 'sparkling water', 'still water'] },
  { icon: 'juice', keywords: ['saft', 'succo', 'jus', 'zumo', 'suc', 'juice', 'nectar', 'smoothie', 'limonada', 'lemonade'] },
  // Juice keeps its fruit ("Suc de Portocale" is nicer as 🍊 than as a carton),
  // but iced tea is not fruit — and "piersici" would outrank a bare "ice tea",
  // so the flavoured forms are spelled out to win on length.
  { icon: 'soda', keywords: ['cola', 'fanta', 'sprite', 'soda', 'soft drink', 'pepsi', 'bautura carbogazoasa', 'ice tea', 'iced tea', 'ice tea piersici', 'ice tea lamaie', 'ice tea de piersici'] },
  { icon: 'energy-drink', keywords: ['energizant', 'energizanta', 'energy drink', 'red bull'] },
  { icon: 'coffee', keywords: ['kaffee', 'kaffeekapseln', 'caffe', 'koffie', 'latte macchiato', 'cafea', 'coffee', 'espresso', 'cappuccino', 'cappucino', 'lungo', 'nescafe'] },
  { icon: 'tea', keywords: ['ceai', 'tea', 'matcha', 'musetel', 'chamomile', 'ceai de menta', 'ceai de fructe de padure', 'earl grey', 'lady grey'] },
  { icon: 'beer', keywords: ['bier', 'birra', 'biere', 'cerveza', 'pils', 'weizen', 'ale', 'bere', 'beer', 'lager', 'pilsner'] },
  { icon: 'wine', keywords: ['weisswein', 'rotwein', 'rosewein', 'wein', 'vino', 'rosso', 'bianco', 'chardonnay', 'pinot', 'riesling', 'lambrusco', 'chianti', 'rioja', 'docg', 'vin', 'wine', 'merlot', 'cabernet', 'sauvignon', 'feteasca'] },
  { icon: 'champagne', keywords: ['spumante', 'sekt', 'prosecco', 'sampanie', 'champagne', 'cava', 'spumant', 'sparkling wine'] },
  { icon: 'spirits', keywords: ['wodka', 'whiskey', 'tequila', 'whisky', 'vodka', 'vodca', 'gin', 'rom', 'tuica', 'palinca', 'lichior', 'liqueur'] },

  // ─── Frozen ────────────────────────────────────────────────────────────────
  { icon: 'ice', keywords: ['gheata', 'ice', 'cuburi de gheata'] },

  // ─── Household ─────────────────────────────────────────────────────────────
  { icon: 'toilet-paper', keywords: ['papel higienico', 'hartie igienica', 'toilet paper', 'servetele', 'napkins', 'prosoape de hartie', 'paper towels'] },
  { icon: 'tissues', keywords: ['servetele faciale', 'servetele demachiante', 'batiste', 'tissues', 'servetele umede', 'wet wipes'] },
  { icon: 'soap', keywords: ['apa micelara', 'micellar water', 'shower gel', 'douchegel', 'duschgel', 'sapun', 'soap', 'gel de dus', 'body wash', 'dezinfectant', 'sanitizer', 'clor'] },
  { icon: 'shampoo', keywords: ['after shave', 'aftershave', 'deodorant', 'antiperspirant', 'anti perspirant', 'roll on', 'sampon', 'shampoo', 'balsam', 'conditioner', 'lotiune', 'lotion', 'crema', 'cream', 'deodorant', 'spuma', 'gel'] },
  { icon: 'laundry', keywords: ['laundry gel', 'laundry', 'fabric conditioner', 'waschmittel', 'lessive', 'detergent', 'detergent de rufe', 'balsam de rufe', 'laundry detergent', 'fabric softener', 'inalbitor', 'bleach'] },
  { icon: 'dishwashing', keywords: ['detergent de vase', 'dish soap', 'masina de spalat vase', 'dishwasher', 'tablete', 'detergent vase', 'detergent pentru vase', 'detergent lichid de vase', 'fairy'] },
  { icon: 'toothbrush', keywords: ['pasta de dinti', 'toothpaste', 'periuta', 'toothbrush', 'apa de gura', 'mouthwash', 'ata dentara', 'floss'] },
  { icon: 'razor', keywords: ['aparate de ras', 'aparat de ras', 'razor', 'spuma de ras', 'shaving', 'lame'] },
  { icon: 'sponge', keywords: ['praf de curatat', 'crema abraziva', 'abrasive', 'burete', 'bureti', 'sponge', 'sponges', 'laveta', 'lavete', 'cloth', 'manusi de menaj', 'rubber gloves'] },
  { icon: 'window-cleaner', keywords: ['geamuri', 'window', 'solutie de geamuri', 'glass cleaner'] },
  { icon: 'trash-bags', keywords: ['saci de gunoi', 'saci menajeri', 'gunoi', 'garbage bags', 'trash bags'] },
  { icon: 'candle', keywords: ['odorizant', 'air freshener', 'lumanare', 'candle', 'betisoare parfumate'] },
  { icon: 'insecticide', keywords: ['insecticid', 'insect', 'anti tantari', 'mosquito'] },
  { icon: 'matches', keywords: ['chibrituri', 'matches', 'bricheta', 'lighter', 'carbune', 'charcoal'] },
  { icon: 'battery', keywords: ['baterii', 'baterie', 'battery', 'batteries', 'acumulator'] },
  { icon: 'light-bulb', keywords: ['bec', 'becuri', 'bulb', 'led', 'lanterna', 'flashlight'] },

  // ─── Personal & household ─────────────────────────────────────────────────────
  { icon: 'plaster', keywords: ['vata', 'cotton', 'betisoare de urechi', 'cotton buds', 'plasturi', 'plasture', 'bandage', 'pansament'] },
  { icon: 'pills', keywords: ['medicament', 'pastile', 'vitamine', 'vitamins', 'aspirina', 'paracetamol', 'supliment', 'vitamin', 'vitamina', 'magneziu', 'magnesium'] },
  { icon: 'sanitary', keywords: ['incontinence', 'absorbante', 'tampoane', 'sanitary pads', 'tampons'] },
  { icon: 'sunscreen', keywords: ['protectie solara', 'spf 30', 'spf 50', 'spf30', 'spf50', 'spf', 'sun cream', 'sunscreen'] },
  { icon: 'baby', keywords: ['pampers', 'huggies', 'luiers', 'windeln', 'pannolini', 'couches', 'panales', 'plasmon', 'mellin', 'omogeneizzato', 'formula', 'baby milk', 'lapte praf', 'scutece', 'diapers', 'piure bebe', 'baby food', 'bebelusi'] },
  { icon: 'dog-food', keywords: ['pentru caini', 'hundefutter', 'hondenvoeding', 'cibo per cani', 'hrana caini', 'dog food', 'caini', 'dog treats'] },
  { icon: 'cat-food', keywords: ['pentru pisici', 'katzenfutter', 'kattenvoeding', 'cibo per gatti', 'nourriture pour chats', 'hrana pisici', 'cat food', 'pisici', 'cat treats', 'nisip pentru pisici', 'cat litter'] },
]

// Brands that are themselves a category, checked BEFORE the keyword table.
//
// A shopper reading "Pringles Sour Cream & Onion" sees crisps. The keyword
// table sees "sour cream", which is two characters longer than "pringles" and
// therefore wins, and the product renders as dairy. Length is the right
// tie-breaker between two product words and the wrong one between a product
// word and a brand — the brand names the thing, the rest describes its flavour.
// So brands win outright rather than competing on length.
//
// Only brands that make ONE kind of thing may go here. Retailers (Carrefour,
// Lidl, Kaufland) and conglomerates (Nestle, Mars) sell everything, and a brand
// whose name is also an ordinary word — ROM the chocolate bar, Star the crisps,
// Dorna which is both a water and a dairy — would fire on products it never
// made. When in doubt, leave it out and let the keywords decide.
const BRAND_RULES = [
  { icon: 'shampoo', keywords: ['old spice', 'lynx', 'rexona', 'nivea'] },
  { icon: 'chips', keywords: ['pringles', 'lays', 'lay s', 'doritos', 'cheetos', 'takis', 'chio', 'croco'] },
  { icon: 'chocolate', keywords: ['milka', 'heidi', 'poiana', 'kandia', 'snickers', 'twix', 'bounty', 'kitkat', 'kit kat', 'toblerone', 'raffaello', 'ferrero', 'roshen', 'lindt', 'ritter sport', 'novatini'] },
  { icon: 'cookie', keywords: ['eugenia', 'belvita', 'toortitzi'] },
  { icon: 'candy', keywords: ['haribo', 'mentos', 'skittles', 'tic tac'] },
  { icon: 'yogurt', keywords: ['danone', 'danonino', 'activia', 'muller', 'pilos'] },
  { icon: 'milk', keywords: ['napolact', 'zuzu', 'covalact', 'ladorna', 'la dorna', 'milbona'] },
  { icon: 'cheese', keywords: ['hochland', 'almette', 'delaco'] },
  { icon: 'soda', keywords: ['schweppes', 'mountain dew', 'mirinda', '7up', 'seven up'] },
  // No juice brands here on purpose. "Suc de Portocale · Santal" reads better as
  // 🍊 than as a carton, and the keyword table already gets that right — a brand
  // rule would take it away.
  { icon: 'water', keywords: ['aqua carpatica', 'borsec', 'perla harghitei', 'izvorul minunilor'] },
  { icon: 'beer', keywords: ['ursus', 'timisoreana', 'bergenbier', 'stella artois', 'heineken', 'tuborg', 'staropramen'] },
  { icon: 'coffee', keywords: ['jacobs', 'lavazza', 'doncafe', 'tchibo'] },
  { icon: 'ice-cream', keywords: ['algida', 'betty ice'] },
]

// The shopping basket: what a product gets when no rule knows it.
export const GENERIC_ICON = 'generic'

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

// Reduce to single-spaced words with a space at each end, so a keyword can be
// found with a plain includes(" keyword ") — whole-word matching without a regex,
// and notably without lookbehind, which older mobile WebViews do not support.
function toWordBag(value: string) {
  return ` ${normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim()} `
}

// Flattened once at module load: every keyword paired with its emoji, longest
// first so the most specific match wins. sort() is stable, so equal-length
// keywords keep the rule order above.
const flatten = (rules: { icon: string; keywords: string[] }[]) =>
  rules
    .flatMap(({ icon, keywords }) => keywords.map((keyword) => ({ icon, needle: toWordBag(keyword) })))
    .sort((a, b) => b.needle.length - a.needle.length)

// Brands first, so a brand beats any product word regardless of length. Within
// each tier the longest keyword still wins.
const MATCHERS = [...flatten(BRAND_RULES), ...flatten(ICON_RULES)]

// The list re-renders on every mutation and the set of distinct products a
// list sees is small, so memoizing turns a few hundred string scans per row
// into one. Keyed by the word bag: two products that reduce to the same words
// must resolve to the same emoji anyway.
const cache = new Map<string, string>()

// The first word names the product when it is one of these kinds of thing (not "suc": fruit juice shows its fruit on purpose):
// "Suc de mere" is a juice, "Gem de capsuni" a jam, "Sos de rosii" a sauce, and the
// fruit after them only says the flavour. Without this the longer fruit word wins
// ("capsuni" outruns "gem"). Kept to words that name a product on their own, so
// phrases like "apa de gura" still resolve by the longest-keyword rule.
const LEAD_WORDS = new Set(['gem', 'dulceata', 'iaurt', 'inghetata', 'sirop', 'bere', 'vin', 'cafea', 'ceai', 'paine', 'branza', 'cascaval', 'seminte', 'deodorant', 'sampon', 'shampoo', 'cereale', 'chifle', 'cornuri', 'tort', 'chec', 'prajitura'])

function firstMatch(haystack: string) {
  for (const matcher of MATCHERS) {
    if (haystack.includes(matcher.needle)) return matcher.icon
  }
  return GENERIC_ICON
}

export function getProductIcon(productName: string, brand = '') {
  const haystack = toWordBag(`${productName} ${brand}`)

  const cached = cache.get(haystack)
  if (cached) return cached

  const lead = toWordBag(productName).split(' ')[1]
  const icon = lead && LEAD_WORDS.has(lead) ? firstMatch(` ${lead} `) : firstMatch(haystack)

  cache.set(haystack, icon)
  return icon
}

// ─── Aisles ──────────────────────────────────────────────────────────────────
// Which part of a shop a product lives in, for sorting the list the way you walk
// a supermarket. Derived from the icon the rules pick rather than a second
// keyword table: the icon IS the category decision, already made with all the
// care above (brands first, longest keyword wins, whole words only), and a
// second table would drift from it. The rows carry no category of their own and
// nothing on the server needs one; this is only an ordering.
//
// Listed in the order a typical Romanian supermarket is laid out: fresh produce
// at the door, bakery and chilled along the walls, dry goods in the middle,
// drinks and household at the back. It will not match every shop and does not
// have to -- the point is that the things you pick up together sit together.
export const AISLES = [
  'produce',
  'bakery',
  'dairy',
  'meat',
  'prepared',
  'pantry',
  'sweets',
  'drinks',
  'household',
  'personal',
  'other',
] as const

export type Aisle = (typeof AISLES)[number]

const AISLE_ICONS: Record<Exclude<Aisle, 'other'>, string[]> = {
  produce: ['apple', 'pear', 'banana', 'orange', 'lemon', 'watermelon', 'melon', 'pineapple', 'kiwi', 'mango', 'peach', 'cherry', 'strawberry', 'blueberry', 'grapes', 'coconut', 'avocado', 'potato', 'onion', 'garlic', 'carrot', 'tomato', 'cucumber', 'lettuce', 'broccoli', 'corn', 'mushroom', 'pepper', 'pumpkin', 'salad', 'herbs', 'apricot', 'plum', 'beet', 'radish', 'zucchini', 'eggplant', 'cabbage'],
  bakery: ['bread', 'baguette', 'croissant', 'pretzel', 'cake', 'cupcake', 'donut', 'pie'],
  dairy: ['egg', 'milk', 'yogurt', 'cheese', 'butter'],
  meat: ['bacon', 'chicken', 'steak', 'sausage', 'ribs', 'skewer', 'burger', 'sandwich', 'fish', 'shrimp'],
  prepared: ['ice-cream', 'ice', 'pizza', 'taco', 'dumpling', 'soup', 'fried-egg'],
  pantry: ['pasta', 'noodles', 'rice', 'flour', 'cereal', 'mayonnaise', 'sauce', 'beans', 'canned', 'olive', 'sunflower-oil', 'olive-oil', 'salt', 'honey', 'nuts', 'sugar', 'jam'],
  sweets: ['fries', 'cookie', 'chocolate', 'candy', 'popcorn', 'chips'],
  drinks: ['water', 'juice', 'soda', 'energy-drink', 'coffee', 'tea', 'beer', 'wine', 'champagne', 'spirits'],
  household: ['toilet-paper', 'soap', 'laundry', 'dishwashing', 'sponge', 'window-cleaner', 'trash-bags', 'candle', 'insecticide', 'matches', 'battery', 'light-bulb'],
  personal: ['tissues', 'shampoo', 'toothbrush', 'razor', 'plaster', 'pills', 'sanitary', 'sunscreen', 'baby', 'dog-food', 'cat-food'],
}

const AISLE_BY_ICON = new Map<string, Aisle>(
  Object.entries(AISLE_ICONS).flatMap(([aisle, icons]) =>
    icons.map((icon) => [icon, aisle as Aisle] as const),
  ),
)

export function aisleForIcon(icon: string): Aisle {
  return AISLE_BY_ICON.get(icon) ?? 'other'
}

export function getProductAisle(productName: string, brand = ''): Aisle {
  return aisleForIcon(getProductIcon(productName, brand))
}

// Every icon the rules can produce, for the tests that keep the tables in step:
// an icon added to a rule without an aisle would quietly sort its products under
// "Other", and one without a drawing would show the generic basket.
export const RULE_ICONS: string[] = [...new Set([...ICON_RULES, ...BRAND_RULES].map((r) => r.icon))]
