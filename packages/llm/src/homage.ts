// Trademarks to homages: a local table of the trademarked names people put in prompts (games and
// their characters, toy and film brands, cars and sports brands, famous fictional places), each
// rewritten into a generic homage before the prompt reaches any model: "Mario Kart" becomes "a kart
// race with a plumber hero". Deterministic and free (no model call), the same function on the edge
// (/v1/build, its cache key and seed, the patch routes), in the web client (what it sends and the
// Intent card's note) and in MCP. The intent prompt's own rule ("rewrite trademarked names as
// generic homages") stays as the second net for names the table doesn't know.
//
// How names match:
// - whole words, case-insensitive, Unicode-aware ("Mario" never matches inside "marionette" or
//   "scenario"); a space in a name also matches a hyphen, a hyphen is optional ("Pac-Man",
//   "Pac Man", "pacman"), an apostrophe is optional, an é also matches e ("Pokemon");
// - names written in Japanese or Chinese match anywhere (those scripts don't put spaces between words);
// - a name that is also an ordinary word ("Halo", "Sonic", "Portal", "Doom", "Fallout") is matched
//   only written as the brand is (capitalised) and not at the start of a sentence, and a few are
//   left out altogether because the ordinary word is far commoner in a world prompt than the brand
//   ("apple", "jaguar", "mustang", "monopoly", "frozen", "minions", "among us", "animal crossing",
//   "thor", "joker", "tesla"): the intent prompt's rule is their net, and the intent's own words
//   are rewritten again on the way out (homageIntent), since a model can name a brand by itself;
// - a person called Mario is rewritten too: in a prompt for a game world the name nearly always
//   means the plumber, and a generic hero is a harmless miss.
// The longest name wins where two overlap ("Mario Kart" before "Mario"), and an article before a
// name absorbs the homage's own ("a Ferrari" → "a red sports car", never "a a red sports car").

/** One rewrite: the name as the prompt wrote it, and the homage it became. */
export interface Homage {
  from: string;
  to: string;
}

/** A prompt with its trademarked names rewritten, and what was rewritten (in prompt order). */
export interface Homaged {
  text: string;
  homages: Homage[];
}

// names (|-separated variants) → the homage; "c": only written capitalised, never sentence-initial
type Row = readonly [names: string, to: string, flags?: "c"];

const TABLE: readonly Row[] = [
  // ---- Nintendo and friends ----
  ["Super Mario Kart|Mario Kart|Mario Kartu|Mario Kartem", "a kart race with a plumber hero"],
  ["Super Mario Bros|Super Mario Brothers|Super Mario|Mario Bros|Mario Brothers", "a platform adventure with a plumber hero"],
  ["Mario|Mariovi|Mariem|Mariově|Mariowi|マリオ|马里奥|馬力歐", "a plumber hero"],
  ["Luigi|ルイージ|路易吉", "the plumber hero's tall brother"],
  ["Princess Peach|Princess Daisy", "a mushroom-land princess"],
  ["Bowser|クッパ|库巴", "a spiky turtle king"],
  ["Yoshi|ヨッシー|耀西", "a friendly green dinosaur"],
  ["Toad", "a mushroom-capped helper", "c"],
  ["Wario|Waluigi", "a greedy rival plumber"],
  ["Mushroom Kingdom", "a mushroom kingdom of pipes and blocks"],
  ["Donkey Kong|Diddy Kong", "a barrel-throwing giant ape"],
  ["Nintendo|任天堂", "a classic game console maker"],
  ["Nintendo Switch|Game Boy|GameBoy|Nintendo DS|GameCube|Wii", "a handheld game console"],
  ["Legend of Zelda|Zelda|Zeldy|Zeldu|ゼルダ|塞尔达", "a green-tunic sword quest"],
  ["Hyrule|Hyrulu|ハイラル|海拉鲁", "a fairy-tale kingdom of fields and temples"],
  ["Ganondorf|Ganon", "a dark sorcerer king"],
  ["Triforce", "a golden triangle relic"],
  ["Master Sword", "a legendary blade in a stone"],
  ["Metroid|Samus Aran|Samus", "an armoured bounty hunter"],
  ["Kirby|カービィ|星之卡比|卡比", "a round pink puffball hero"],
  ["Splatoon", "a paint-splatting squid team"],
  ["Smash Bros|Super Smash Bros|Super Smash Brothers", "a mascot brawl"],
  ["Pokémon|Pokemon|Pokémons|Pokémoni|Pokémony|Pokémonů|Pokémonech|Pokémonem|Pokemonów|ポケモン|宝可梦|精灵宝可梦|寶可夢", "pocket-monster"],
  ["Pokéball|Poké Ball|Pokeball|Pokéballs|Pokeballs|モンスターボール|精灵球", "a monster-catching capsule"],
  ["Pikachu|ピカチュウ|皮卡丘", "an electric yellow mouse creature"],
  ["Charizard|Charmander|Bulbasaur|Squirtle|Jigglypuff|Eevee|Mewtwo|Snorlax|Gengar|Lucario", "a pocket monster"],
  ["Ash Ketchum", "a young monster trainer"],
  ["Pallet Town", "a quiet starter village"],
  ["Animal Crossing New Horizons|Tom Nook", "a cosy island village with a raccoon shopkeeper"],
  // ---- other games and their worlds ----
  ["Sonic the Hedgehog|ソニック・ザ・ヘッジホッグ|刺猬索尼克", "a speedy blue hedgehog"],
  ["Sonic", "a speedy blue hedgehog", "c"],
  ["Dr. Eggman|Dr Eggman|Eggman|Dr. Robotnik|Robotnik", "a mad egg-shaped inventor"],
  ["Green Hill Zone", "a checkered green hill with loops"],
  ["Pac-Man|Pac-Mana|Pac-Manem|Ms. Pac-Man|Ms Pac-Man|パックマン|吃豆人", "a dot-eating maze runner"],
  ["Tetris|Tetrisu|テトリス|俄罗斯方块", "a falling-block puzzle"],
  ["Space Invaders", "an alien wave shooter", "c"],
  ["Frogger", "a road-crossing frog game"],
  ["Minecraft|Minecraftu|Minecraftem|マインクラフト|我的世界", "a blocky crafting game"],
  ["Creeper", "a hissing green blast monster", "c"],
  ["Enderman|Endermen", "a tall teleporting shadow creature"],
  ["Fortnite|Fortnitu|フォートナイト|堡垒之夜", "a battle royale with building"],
  ["Battle Bus", "a flying drop-off bus"],
  ["Roblox", "a blocky online game park"],
  ["Among Us", "a spaceship crew with an impostor", "c"],
  ["Fall Guys", "a wobbly obstacle-course show", "c"],
  ["Rocket League", "car football"],
  ["Call of Duty|CoD Warzone", "a military shooter", "c"],
  ["Halo", "a ring-world space marine saga", "c"],
  ["Master Chief", "an armoured space marine"],
  ["Grand Theft Auto|GTA", "an open-city crime caper"],
  ["Vice City|Liberty City|Los Santos", "a sunny crime-movie city"],
  ["Red Dead Redemption|Red Dead", "a frontier outlaw western"],
  ["Skyrim|Elder Scrolls|Tamriel", "a snowy northern fantasy realm"],
  ["The Witcher|Witcher|Geralt of Rivia|Geralt", "a monster-hunting swordsman"],
  ["Cyberpunk 2077", "a neon megacity game"],
  ["Night City", "a neon megacity", "c"],
  ["World of Warcraft|Warcraft|Azeroth", "a high-fantasy war realm"],
  ["StarCraft", "a space war of three races"],
  ["Overwatch", "a team hero shooter", "c"],
  ["League of Legends|Summoner's Rift", "a three-lane battle arena"],
  ["Dota 2|Dota|DotA", "a three-lane battle arena"],
  ["Valorant", "a tactical team shooter"],
  ["Counter-Strike|CS:GO|CSGO", "a tactical team shooter"],
  ["Apex Legends", "a squad battle royale"],
  ["PUBG|PlayerUnknown's Battlegrounds", "a battle royale"],
  ["Street Fighter", "a street martial-arts tournament", "c"],
  ["Mortal Kombat", "a brutal martial-arts tournament"],
  ["Tekken", "an iron-fist martial-arts tournament"],
  ["Final Fantasy", "a crystal-quest fantasy epic", "c"],
  ["Chocobo|Chocobos", "a big yellow riding bird"],
  ["Kingdom Hearts", "a key-blade fantasy crossover"],
  ["Dark Souls|Elden Ring|Bloodborne", "a grim knightly fantasy", "c"],
  ["Silent Hill", "a fog-bound haunted town", "c"],
  ["Resident Evil|Raccoon City|Umbrella Corporation", "a zombie-outbreak city", "c"],
  ["BioShock|Bioshock", "a sunken art-deco city"],
  ["Portal", "a test-chamber puzzle with a portal gun", "c"],
  ["Aperture Science|GLaDOS", "a sarcastic test-lab AI"],
  ["Half-Life|Half Life", "a sci-fi lab escape", "c"],
  ["Doom", "a demon-blasting space marine", "c"],
  ["Fallout", "a post-nuclear wasteland", "c"],
  ["Vault-Tec|Pip-Boy", "a retro-future bunker company"],
  ["Mass Effect", "a galactic space opera", "c"],
  ["Tomb Raider|Lara Croft", "a daring tomb explorer", "c"],
  ["Uncharted|Nathan Drake", "a treasure-hunting adventurer", "c"],
  ["Assassin's Creed", "a hooded parkour assassin"],
  ["Hollow Knight", "a bug knight in a ruined kingdom", "c"],
  ["Stardew Valley", "a cosy farming valley"],
  ["Terraria", "a 2D digging adventure"],
  ["Angry Birds", "slingshot birds against fortresses", "c"],
  ["Candy Crush", "a candy match-three puzzle", "c"],
  ["Flappy Bird", "a tap-to-flap bird", "c"],
  ["Crash Bandicoot", "a spinning orange marsupial"],
  ["Spyro", "a small purple dragon"],
  ["Rayman", "a limbless cartoon hero"],
  ["Mega Man|Megaman|Rockman", "a blue robot hero"],
  ["Bomberman", "a bomb-laying maze hero"],
  ["Pong", "a two-paddle ball game", "c"],
  ["Geometry Dash", "a rhythm cube runner", "c"],
  ["Subway Surfers", "an endless rail-yard runner", "c"],
  ["Temple Run", "an endless temple runner", "c"],
  ["Five Nights at Freddy's|Five Nights at Freddys|FNAF", "a haunted animatronic pizzeria"],
  ["PlayStation|PS5|PS4|プレイステーション", "a game console"],
  ["Xbox", "a game console"],
  ["Sega|セガ|世嘉", "a classic game console maker"],
  ["Atari", "a retro arcade maker"],
  // ---- films, books and TV: characters ----
  ["Star Wars|Hvězdné války|Hvězdných válek|Hvězdných válkách|Gwiezdnych wojen|Krieg der Sterne|La Guerre des étoiles|Guerre stellari|Gwiezdne wojny|La guerra de las galaxias|Guerra nas Estrelas|スター・ウォーズ|星球大战|星際大戰", "a galactic space-knight saga"],
  ["Jedi|Jedis|ジェダイ|绝地", "a space knight"],
  ["Sith", "a dark space knight"],
  ["Darth Vader|ダース・ベイダー|达斯·维达", "a masked dark space lord"],
  ["Luke Skywalker|Skywalker", "a young space-knight hero"],
  ["Han Solo", "a roguish smuggler pilot"],
  ["Chewbacca|Wookiee|Wookie", "a tall furry co-pilot"],
  ["Yoda", "a tiny wise green master"],
  ["R2-D2|R2D2|C-3PO|C3PO|BB-8", "a beeping droid"],
  ["Stormtrooper|Stormtroopers", "an armoured space soldier"],
  ["Lightsaber|Lightsabers|Lichtschwert|Světelný meč|sabre laser", "a laser sword"],
  ["Death Star|Todesstern|Hvězda smrti|Hvězdy smrti|Hvězdu smrti|Hvězdě smrti|Étoile de la mort|Estrella de la Muerte", "a moon-sized battle station"],
  ["Millennium Falcon|Millenium Falcon", "a battered freighter spaceship"],
  ["X-wing|TIE fighter", "a starfighter"],
  ["Tatooine", "a far-off desert planet"],
  ["Hoth", "a frozen rebel planet"],
  ["Coruscant", "a city-covered planet"],
  ["Endor", "a forest moon"],
  ["Naboo", "a lush lake planet"],
  ["Harry Potter|Harryho Pottera|Harry Pottera|Harrego Pottera|ハリー・ポッター|哈利·波特|哈利波特", "a boy wizard"],
  ["Hogwarts|Bradavice|Bradavic|Bradavicích|Bradavicemi|Bradavicím|Poudlard|Hogwart|Hogwartu|Hogwarcie|Hogwartem|ホグワーツ|霍格沃茨|霍格華茲", "a wizard school castle"],
  ["Hermione Granger|Hermione|Ron Weasley", "a young wizard friend"],
  ["Dumbledore", "a white-bearded headmaster"],
  ["Hagrid", "a giant groundskeeper"],
  ["Snape|Severus Snape", "a stern potions master"],
  ["Voldemort|Lord Voldemort|Voldemorte", "a dark wizard"],
  ["Quidditch|Quidditchu|Quidditche|Famfrpál|Famfrpálu|Quidditch-Spiel", "a broomstick ball game"],
  ["Gryffindor|Slytherin|Hufflepuff|Ravenclaw|Nebelvír|Zmijozel", "a wizard school house"],
  ["Hogsmeade|Diagon Alley|Příčná ulice", "a crooked wizard village street"],
  ["Lord of the Rings|Pán prstenů|Pána prstenů|Władcy Pierścieni|Der Herr der Ringe|Le Seigneur des anneaux|El Señor de los Anillos|Il Signore degli Anelli|Władca Pierścieni|O Senhor dos Anéis|ロード・オブ・ザ・リング|指环王|魔戒", "an epic quest to destroy a ring"],
  ["Middle-earth|Middle Earth|Mittelerde|Středozem|Středozemě|Středozemi|Śródziemie|Śródziemiu", "a fantasy land of elves and dwarves"],
  ["Mordor|Mordoru", "a dark volcanic land"],
  ["Rivendell|Lothlórien|Lothlorien", "a hidden elven valley"],
  ["Gondor|Minas Tirith|Isengard|Helm's Deep", "a great stone fortress city"],
  ["Gandalf|Gandalfa|Gandalfem", "a grey-robed wizard"],
  ["Frodo|Frodo Baggins|Bilbo|Bilbo Baggins|Samwise", "a small hairy-footed hero"],
  ["Hobbit|Hobbits|Hobbiton|Hobit", "a small hairy-footed folk"],
  ["Gollum|Sméagol|Smeagol", "a skulking cave creature"],
  ["Sauron|Eye of Sauron", "a dark lord's flaming eye"],
  ["Narnia|Narnie|Narnii|Aslan", "a wardrobe-door fantasy kingdom"],
  ["Game of Thrones|Westeros|Winterfell|King's Landing|Iron Throne", "a medieval kingdom of feuding houses"],
  ["Jurassic Park|Jurassic World", "a dinosaur theme park"],
  ["Ghostbusters", "ghost-catching exterminators"],
  ["Indiana Jones", "a whip-cracking archaeologist"],
  ["James Bond|007", "a suave secret agent"],
  ["The Matrix", "a simulated-reality uprising", "c"],
  ["Blade Runner", "a rain-soaked replicant hunt", "c"],
  ["Mad Max", "a wasteland car chase"],
  ["Star Trek|USS Enterprise|Starfleet", "a starship exploration crew"],
  ["Klingon|Klingons", "a warrior alien"],
  ["Doctor Who|TARDIS|Tardis", "a time-travelling police box"],
  ["Dalek|Daleks", "a pepper-pot alien robot"],
  ["Stranger Things|Hawkins Lab|Demogorgon", "an eighties small-town mystery"],
  ["Willy Wonka|Wonka|Oompa Loompa|Oompa Loompas", "a candy-factory inventor"],
  ["Xenomorph|Xenomorphs", "a biomechanical alien"],
  ["Godzilla|ゴジラ|哥斯拉", "a giant atomic lizard"],
  ["King Kong", "a giant ape"],
  ["Tron", "a glowing digital grid world", "c"],
  ["Pirates of the Caribbean|Jack Sparrow|Black Pearl", "a cursed pirate crew", "c"],
  ["Hunger Games|Katniss", "a deadly televised survival contest"],
  ["Squid Game", "a deadly playground-games contest"],
  ["Shrek", "a grumpy green ogre"],
  ["Toy Story", "toys that come to life", "c"],
  ["Buzz Lightyear", "a toy space ranger"],
  ["Monsters, Inc.|Monsters Inc|Monstropolis", "a monster-run scare factory"],
  ["Finding Nemo", "a little clownfish"],
  ["Arendelle|Elsa and Anna|Olaf the snowman", "an ice-queen kingdom"],
  ["Despicable Me|Gru", "a supervillain with little yellow helpers", "c"],
  ["Kung Fu Panda", "a martial-arts panda", "c"],
  ["How to Train Your Dragon|Toothless", "a dragon-riding village", "c"],
  ["Cars movie|Lightning McQueen", "a talking race car"],
  // ---- comics and superheroes ----
  ["Spider-Man|Spiderman|Spider Man|Spider-Mana|Spider-Manem|スパイダーマン|蜘蛛侠", "a web-slinging hero"],
  ["Batman|Batmana|Batmanem|Batmanovi|バットマン|蝙蝠侠", "a caped night vigilante"],
  ["Batmobile", "a black armoured hero car"],
  ["Batcave", "a hero's secret cave base"],
  ["Gotham City|Gotham", "a gothic crime-ridden city"],
  ["Metropolis", "a gleaming skyscraper city", "c"],
  ["Superman|Supermana|Supermanem|スーパーマン", "a caped flying strongman"],
  ["Wonder Woman", "an amazon warrior hero"],
  ["Iron Man", "a hero in a rocket-powered suit", "c"],
  ["Captain America", "a shield-throwing soldier hero"],
  ["Incredible Hulk|the Hulk", "a giant green rage monster"],
  ["Black Panther|Wakanda", "a hidden high-tech kingdom", "c"],
  ["Avengers|Avengers Tower", "a team of superheroes", "c"],
  ["X-Men|Wolverine", "a team of mutant heroes", "c"],
  ["Deadpool", "a wisecracking masked mercenary"],
  ["Thanos|Infinity Gauntlet|Infinity Stones", "a warlord's jewelled gauntlet"],
  ["Teenage Mutant Ninja Turtles|Ninja Turtles|TMNT", "sewer-dwelling ninja turtles"],
  ["Optimus Prime|Megatron|Autobots|Decepticons|Cybertron", "a giant shape-shifting robot"],
  ["Power Rangers", "colour-coded martial-arts heroes"],
  // ---- cartoons and toys ----
  ["Mickey Mouse|Minnie Mouse|ミッキーマウス|米老鼠|米奇", "a cheerful cartoon mouse"],
  ["Donald Duck", "a cranky cartoon duck"],
  ["Disneyland|Disney World|Walt Disney World|ディズニーランド|迪士尼乐园", "a fairy-tale theme park"],
  ["Disney|ディズニー|迪士尼", "a classic cartoon studio"],
  ["Pixar", "an animation studio"],
  ["SpongeBob|SpongeBob SquarePants|Sponge Bob|Bikini Bottom|Krusty Krab", "an undersea cartoon town"],
  ["Scooby-Doo|Scooby Doo|Mystery Machine", "a mystery-solving dog and friends", "c"],
  ["Winnie the Pooh|Winnie-the-Pooh|Hundred Acre Wood", "a honey-loving bear's wood"],
  ["Peppa Pig", "a cartoon piglet family"],
  ["Paw Patrol", "a team of rescue puppies"],
  ["Bluey", "a cartoon puppy family", "c"],
  ["Hello Kitty|ハローキティ|凯蒂猫", "a cute bow-wearing kitten"],
  ["My Little Pony", "magical pastel ponies"],
  ["Care Bears", "rainbow-bellied bears"],
  ["Teletubbies", "round-bellied TV toddlers"],
  ["Smurfs|Smurf|Šmoulové", "little blue forest folk"],
  ["Looney Tunes|Bugs Bunny|Road Runner|Wile E. Coyote", "a zany cartoon rabbit", "c"],
  ["Tom and Jerry", "a cat chasing a mouse", "c"],
  ["Simpsons|The Simpsons|Homer Simpson", "a yellow cartoon family", "c"],
  ["Lego bricks|LEGO bricks|Lego blocks|Lego pieces", "toy building bricks"],
  ["LEGO|Lego|Legos|Legem|Legu|レゴ|乐高|樂高", "toy-brick"],
  ["Duplo", "big toy building bricks"],
  ["Playmobil", "toy figure sets"],
  ["Barbie|Barbies|Barbie Dreamhouse", "a fashion doll"],
  ["Hot Wheels", "toy die-cast cars", "c"],
  ["Nerf gun|Nerf guns|Nerf blaster|Nerf blasters|Nerf war", "a foam dart blaster"],
  ["Rubik's Cube|Rubik's cubes|Rubiks Cube|Rubik Cube", "a twisty puzzle cube"],
  ["Jenga", "a wooden block-stacking tower"],
  ["Tamagotchi", "a pocket virtual pet"],
  ["Furby|Furbies", "a chattering furry toy"],
  ["Beyblade|Beyblades", "a battling spinning top"],
  ["Yu-Gi-Oh|Yugioh", "a monster card duel"],
  ["Frisbee|Frisbees", "a flying disc"],
  ["Jet Ski|Jet Skis|Jetski", "a personal watercraft"],
  ["Zamboni", "an ice-resurfacing machine"],
  ["Hula Hoop|Hula-Hoop", "a spinning hoop", "c"],
  // ---- cars and vehicles ----
  ["Ferrari|Ferraris|フェラーリ|法拉利", "a red sports car"],
  ["Lamborghini|Lamborghinis|Lambo|Lambos|ランボルギーニ|兰博基尼", "a wedge-shaped supercar"],
  ["Porsche|Porsches|ポルシェ|保时捷", "a sleek sports car"],
  ["Bugatti|Bugattis", "a hypercar"],
  ["McLaren|McLarens", "a supercar"],
  ["Maserati|Aston Martin|Rolls-Royce|Rolls Royce|Bentley", "a luxury car", "c"],
  ["Mercedes-Benz|Mercedes Benz", "a luxury saloon car"],
  ["BMW|BMWs|Audi|Volkswagen|VW|Toyota|Honda|Nissan|Chevrolet|Chevy|Cadillac|Hyundai|Kia|Subaru|Mazda|Škoda|Skoda|Volvo|Peugeot|Renault|Citroën|Citroen", "a car"],
  ["Ford Mustang|Shelby Mustang|Chevrolet Camaro|Dodge Charger|Dodge Challenger|Chevrolet Corvette", "an American muscle car"],
  ["DeLorean", "a stainless-steel time-machine car"],
  ["Jeep|Jeeps|Land Rover|Range Rover|Hummer", "an off-road car"],
  ["Harley-Davidson|Harley Davidson|Harleys|Ducati|Kawasaki", "a big motorbike"],
  ["Vespa|Vespas", "a scooter"],
  ["Formula 1|Formula One|Formule 1|Formel 1", "an open-wheel grand prix"],
  ["NASCAR", "a stock-car oval race"],
  ["Le Mans", "a 24-hour endurance race", "c"],
  ["Boeing 747|Boeing|Airbus", "an airliner"],
  ["Cessna", "a small propeller plane"],
  ["Ski-Doo|Skidoo", "a snowmobile"],
  ["SpaceX|Starship rocket", "a reusable rocket"],
  // ---- sports and food brands ----
  ["Nike sneakers|Nike shoes|Nike Air|Air Jordan|Air Jordans|Adidas|Reebok|Under Armour|Vans sneakers", "a sneaker brand"],
  ["NBA|NFL|NHL|MLB|FIFA|UEFA|Premier League|Champions League|La Liga|Bundesliga", "a pro sports league"],
  ["World Cup", "a world football cup", "c"],
  ["Super Bowl", "a championship football final"],
  ["Olympics|Olympic Games|Olympijské hry|Olympische Spiele|Jeux olympiques|Juegos Olímpicos|オリンピック|奥运会", "an international sports festival"],
  ["Wimbledon", "a grass-court tennis championship"],
  ["Tour de France", "a long-distance bike race"],
  ["Real Madrid|FC Barcelona|Manchester United|Manchester City|Liverpool FC|Bayern Munich|Bayern München|Juventus|Chelsea FC|Arsenal FC|Sparta Praha|Slavia Praha", "a famous football club"],
  ["Lakers|Yankees|Chicago Bulls|Golden State Warriors", "a famous sports team"],
  ["Harlem Globetrotters", "a trick-shot basketball team"],
  ["WWE|WWF wrestling", "a pro wrestling show"],
  ["Red Bull", "an energy drink", "c"],
  ["Coca-Cola|Coca Cola|Pepsi|Fanta|Gatorade", "a fizzy drink", "c"],
  ["McDonald's|McDonalds|Big Mac|Burger King|KFC|Starbucks|Subway restaurant|Taco Bell|Pizza Hut", "a fast-food restaurant"],
  ["IKEA|Ikea", "a flat-pack furniture store"],
  ["Gucci|Prada|Louis Vuitton|Chanel|Hermès|Hermes Birkin|Birkin bag|Rolex", "a luxury fashion brand", "c"],
  ["iPhone|iPad|MacBook|PlayStation 5", "a gadget"],
  ["Google|YouTube|TikTok|Instagram|Facebook|Twitter|Netflix|Amazon Prime|Spotify|Discord", "a social media app", "c"],
  ["Hogwarts Express", "a steam train to wizard school"],
];

/** Every trademarked name the table knows (each variant once), and whether it counts only capitalised, for tests and audits. */
export const TRADEMARKS: readonly { name: string; cased: boolean }[] = [...new Map(TABLE.flatMap(([names, , flags]) => names.split("|").map((name) => [name, { name, cased: flags === "c" }] as const))).values()];

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name as a pattern: a space also matches a hyphen, a hyphen is optional, so are apostrophes and full stops; é also matches e. */
function pattern(name: string): string {
  return [...name]
    .map((ch) => {
      if (ch === " ") return "[\\s\\-]+";
      if (ch === "-") return "[\\s\\-]?";
      if (ch === "'" || ch === "’") return "['’]?";
      if (ch === ".") return "\\.?";
      const plain = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return plain !== ch && plain.length === 1 ? `[${escape(ch)}${escape(plain)}]` : escape(ch);
    })
    .join("");
}

interface Entry {
  re: RegExp;
  to: string;
  cased: boolean;
}
// one regex per row and kind (the longest name first in each, so "Super Mario" beats "Mario" there)
const ENTRIES: Entry[] = TABLE.flatMap(([names, to, flags]): Entry[] => {
  const all = names.split("|").sort((a, b) => b.length - a.length);
  const words = all.filter((n) => !CJK.test(n));
  const cjk = all.filter((n) => CJK.test(n));
  const cased = flags === "c";
  const out: Entry[] = [];
  if (words.length) out.push({ re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(pattern).join("|")})(?![\\p{L}\\p{N}_])`, cased ? "gu" : "giu"), to, cased });
  if (cjk.length) out.push({ re: new RegExp(cjk.map(escape).join("|"), "gu"), to, cased: false });
  return out;
});

/** The start of a sentence: nothing before, or a full stop, question or exclamation mark, a colon or a line break. */
const sentenceStart = (before: string) => /(^|[.!?:;\n]["'’”)]*)\s*$/u.test(before);

/**
 * The prompt with its trademarked names rewritten as generic homages, and what was rewritten. The
 * same input always gives the same output, and the output has no name from the table left in it
 * (the homages name none), so a rewritten prompt comes back as it is.
 */
export function homage(prompt: string, opts: { label?: boolean } = {}): Homaged {
  const found: { start: number; end: number; to: string }[] = [];
  for (const e of ENTRIES) {
    e.re.lastIndex = 0;
    for (let m = e.re.exec(prompt); m; m = e.re.exec(prompt)) {
      if (!m[0]) {
        e.re.lastIndex++;
        continue;
      }
      // a brand that is also an ordinary word: only mid-sentence, and only with its capitals
      // (a label, like the model's name for a thing, isn't a sentence: its capital means the brand)
      if (e.cased && !opts.label && sentenceStart(prompt.slice(0, m.index)) && !m[0].includes(" ")) continue;
      found.push({ start: m.index, end: m.index + m[0].length, to: e.to });
    }
  }
  if (!found.length) return { text: prompt, homages: [] };
  // the earliest wins, then the longest; nothing overlaps
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const spans: typeof found = [];
  for (const f of found) if (!spans.length || f.start >= spans[spans.length - 1]!.end) spans.push(f);

  let out = "";
  let at = 0;
  const homages: Homage[] = [];
  for (const s of spans) {
    let before = out + prompt.slice(at, s.start);
    let to = s.to;
    // an article before the name takes the homage's place: "a Ferrari" → "a red sports car"
    const art = /(^|[^\p{L}])(a|an|the|my|your|our|his|her|their|this|that|every|each)(\s+)$/iu.exec(before);
    const own = /^(a|an|the) /i.exec(to);
    if (art && own) to = to.slice(own[0].length);
    // and "a" or "an" agrees with what now follows it ("an Xbox" → "a game console")
    const word = art?.[2];
    if (art && word && /^an?$/i.test(word)) {
      const want = /^[aeiou]/i.test(to) ? "an" : "a";
      const fixed = word[0] === word[0]!.toUpperCase() ? want[0]!.toUpperCase() + want.slice(1) : want;
      before = before.slice(0, before.length - art[3]!.length - word.length) + fixed + art[3];
    }
    // a sentence that opens with the name opens with the homage, capitalised
    if (sentenceStart(before)) to = to.charAt(0).toUpperCase() + to.slice(1);
    out = before + to;
    at = s.end;
    const from = prompt.slice(s.start, s.end);
    if (!homages.some((h) => h.from.toLowerCase() === from.toLowerCase())) homages.push({ from, to: s.to });
  }
  return { text: out + prompt.slice(at), homages };
}

/** The Intent card's note, in English: "Homage: 'Mario Kart' → 'a kart race with a plumber hero'; we don't use trademarked names". */
export function homageNote(hs: readonly Homage[]): string | null {
  return hs.length ? `Homage: ${hs.map((h) => `'${h.from}' → '${h.to}'`).join(", ")}; we don't use trademarked names` : null;
}

/**
 * The intent model's words with any brand it named rewritten too (its setting, goal, headline and
 * the rest, and its nouns): asked for a "flight over Metropolis rooftops" it answered with "a
 * Superman-style homage". The same table, so the same rewrite as the prompt's.
 */
export function homageIntent<T extends { nouns: { noun: string; hyper: string }[] }>(intent: T, keys: readonly (keyof T & string)[]): T {
  const out = { ...intent } as Record<string, unknown>;
  for (const k of keys) if (typeof out[k] === "string") out[k] = homage(out[k] as string).text;
  out.nouns = intent.nouns.map((n) => ({ ...n, noun: homage(n.noun, { label: true }).text, hyper: homage(n.hyper).text }));
  return out as T;
}
