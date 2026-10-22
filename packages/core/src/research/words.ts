export * as ResearchWords from "./words"

// Common English words, for telling a name from a word that is capitalised only because it starts a sentence or
// stands in a heading: "Heat pumps are loud" starts with a word, "Falcon is the codename" with a name. A word counts
// with its usual endings ("customers", "deployed", "planning", "quickly").
//
// Words that are often the names of people, companies or code names are left out on purpose, since a name read as a
// word could go into a query: colours, animals, fruit, gems, planets and gods, and words such as "mark", "bill",
// "grace", "shell", "oracle" and "summit". The cost of leaving a word out is small: a private line that starts with it
// keeps it out of queries until the user types it.

const WORDS = new Set(
  `
  ability able about above abroad absence academic accept access accident according account accurate achieve acid
  acquire across act action actions active activity actor actual actually adapt add addition additional address
  adjust admin admit adopt adult advance advanced advantage advertising advice advise advisory affair affect afford
  afraid after afternoon afterwards again against age agency agenda agent ago agree agreement ahead aid aim air alarm
  alert alive all allow almost alone along already also alternative although always amazing ambiguous among amount
  analyse analysis analyst analyze ancient and angle angry annual another answer answers anxiety any anybody anyone
  anything anyway anywhere apart apartment app apparent apparently appeal appear appendix application apply
  appointment appreciate approach appropriate approval approve approximately area argue argument arise arm army
  around arrange arrival arrive article artist aside ask asleep aspect assess assessment asset assign assignment
  assist assistant assume assumption assumptions attach attack attempt attend attendees attention attitude attract
  audience audit author authority automatic automatically available average avoid awake award aware awareness away
  awful baby back backend background backup bad badly bag balance ball band bank bar barely base basic basically
  basis basket bath battery battle beach beat beautiful because become bed bedroom beer before beforehand begin
  beginning behalf behave behavior behaviour behind being belief believe belong below beneath benefit beside besides
  best better between beyond big bike billion bind birth birthday bit bitter blame blank blind blog blood board boat
  body bold bone bonus book boost border boring born borrow boss both bother bottle bottom bound box boy brain branch
  brand bread break breakfast breath brief briefly bright brilliant bring broad broken brother budget bug build
  building bunch burn bus business busy but button buy buyer cabinet cable cache cake calculate calendar call calm
  camera camp campaign can cancel cancer candidate capable capacity capital car card care career careful carefully
  carry case cash casual catch category cause cell center central centre century certain certainly chain chair
  challenge chance change channel chapter character charge chart cheap check chief child childhood children choice
  choose church circle citizen city civil claim class classic classroom clean clear clearly clever click client
  climate climb clock close closely closet cloud club coach coast code codename coffee cold collapse colleague
  collect collection college column combination combine come comfortable command comment commercial commit common
  commonly communicate community company compare comparison compete competition competitive complain complaint
  complete completely complex component compute computer concept concern concert conclude conclusion condition
  conduct conference confidence confident config configuration confirm conflict confused connect connection cons
  consequence consider consist consistent constant constantly constraint constraints construct construction consumer
  contact contain container content contest context continue contract contrast contribute contribution control
  convenient conversation convert convince cool copy core corner correct cost could council count counter country
  county couple courage course court cousin cover crack craft crash crazy create creative credit crew crime crisis
  criteria critical criticism cross crowd crucial cry culture cup curious currency current currently custom customer
  cut cute cycle dad daily damage dance danger dangerous dark data database date daughter day dead deadline deal dear
  death debate debt debug decade decent decide decision decisions deck declare decline decrease deep deeply default
  defeat defend define defined definitely definition degree delay delete deliberately deliver deliverable
  deliverables delivery demand demo deny department depend dependencies dependency deploy deployment deposit depth
  describe description desert deserve design desk desktop despite destroy detail detailed detect determine develop
  developer development device diagram die diet differ difference different differently difficult difficulty dig
  digital dinner direct direction directly director directory dirty disable disagree disappear discount discover
  discuss discussion disease dish disk dislike display distance distinct distribute distribution district divide doc
  doctor document documentation domain domestic door double doubt down download downstairs dozen draft drag drama
  draw drawing dream dress drink drive driver drop drug dry due dull during duty each eager early earn earth easily
  east eastern easy eat economic economy edge edit edition editor educate education effect effective effectively
  efficiency efficient effort eight either elderly elect election electric electronic element eleven eliminate else
  elsewhere email embed emerge emergency emotion emotional emphasis employ employee employer employment empty enable
  encourage end endpoint enemy energy enforce engage engine engineer engineering enhance enjoy enough ensure enter
  entire entirely entry environment environmental equal equally equip equipment error escape especially essential
  essentially establish estate estimate evaluate even evening event eventually ever every everybody everyday everyone
  everything everywhere evidence evident evil exam examine example excellent except exception exchange excited
  excitement exciting exclude excuse execute executive exercise exist existing exit expand expect expectation expense
  expensive experience experienced experiment experimental expert explain explanation explicit explore export express
  expression extend extension extent external extra extract extreme extremely eye face facility fact factor factory
  fail failure fair fairly fall false familiar family famous fan fancy far farm farmer fashion fast fat father fault
  favor favorite favour favourite fear feature fee feed feedback feel feeling fellow female fetch few field fifteen
  fifth fifty fight figure file fill film filter final finally finance financial find finding findings fine finger
  finish fire firm firmly first fit five fix flag flat flexible flight flip float floor flow fly focus fold folder
  follow following followup font food foot football for force forecast foreign forest forever forget forgive form
  formal format former formerly forth forty forum forward found foundation four fourth frame framework free freedom
  freely freeze frequent frequently fresh friend friendly friendship from front frontend fruit fuel full fully fun
  function functional fund funding funny further furthermore future gain game gap garage garden gas gate gather gear
  general generally generate generation generic gentle gently genuine get giant gift girl give glad glass global goal
  goals government grab grade gradual gradually grand grant graph grass grateful great greatly gross ground group
  grow growth guarantee guard guess guest guidance guide guilty gun habit hair half hall hand handle hang happen
  happy hard hardly hardware harm harmful harsh hate have head health healthy hear hearing heart heat heavily heavy
  height hello help helpful hence here hers herself hidden hide high highlight highly highway him himself hire his
  historic historical history hit hobby hold hole holiday home homework honest honestly hook horrible hospital host
  hot hotel hour house household housing how however huge human hundred hungry hurry hurt husband idea ideal
  identical identify ignore ill illegal image imagine immediate immediately impact implement imply import importance
  important impossible impress impression impressive improve improvement inch incident include including income
  incorrect increase increasingly incredible indeed independent index indicate individual industrial industry
  inevitable infection inflation influence inform informal information infrastructure initial initially injury inline
  inner innocent input inside insight insist inspect inspection install instance instant instantly instead
  institution instruction insurance integrate integration intend intense intention interaction interactive interest
  interested interesting interface internal internally international internet interview into introduce introduction
  invalid invest investigate investigation investment invite invoice involve involved issue item itself job join
  joint joke journey judge judgment juice jump junior jury just justice justify keen keep key keyboard kick kid kill
  kind kitchen knock know knowledge lab label labor labour lack lady land landscape language laptop large largely
  last late lately later latest laugh launch law lawyer lay layer layout lazy lead leader leadership leading league
  lean learn learning least leave lecture left leg legacy legal legitimate lend length lengthy less lesson let letter
  level library licence license lie life lifestyle lift light lightly likely limit limited line linear link list
  listen literally literature little live load loan local locally locate location lock log logic logical login lonely
  long look loose lose loss lost lot loud loudly love lovely low loyal luck luckily lucky lunch machine magazine mail
  main mainly maintain maintenance major majority make male manage management manager manner manual manually
  manufacturer many map market marketing marriage married massive master match material math mathematics matter
  mature maximum meal meaning meanwhile measure measurement meat media medical medicine medium meet meeting member
  membership memory mental mention menu mere merely merge mess message metal method metric middle midnight migrate
  migration mild milestone milestones military milk million mind minimal minimum minister minor minority minute
  minutes mirror miss missing mission mistake mix mixed mobile mode model moderate modern modify module mom moment
  money monitor month monthly mood moral more moreover morning mortgage most mostly mother motion motor mountain
  mouth move movement movie mum music must mutual myself name narrow nation national native natural naturally nature
  near nearby nearly neat necessarily necessary neck need negative negotiate negotiation neighbor neighbour neither
  nervous net network neutral never nevertheless news newspaper next nice night nine nobody node noise noisy none
  nonetheless noon normal normally north northern nose notable notably note notes nothing notice notify novel nowhere
  number numerous nurse object objective objectives obligation observe obtain obvious obviously occasion occasionally
  occur odd offer office officer official officially often oil okay old omit once one ongoing online only onto open
  opening openly operate operation opinion opponent opportunity oppose opposite option optional options order
  ordinary organic organisation organise organization organize origin original originally otherwise ought ourselves
  out outcome outdoor output outside outstanding over overall overnight overview owe own owner owners pack package
  page pain painful paint painting pair panel paper parent park part partial partially participate particular
  particularly partly partner party pass passage passenger passive password past patch path patient pattern pause pay
  payment peace peaceful penalty pension people percent percentage perfect perfectly perform performance perhaps
  period permanent permanently permission permit person personal personally perspective persuade phase phone photo
  phrase physical physically physics piano pick picture piece pipeline place plain plan plane planet plant plastic
  plate platform play player pleasant please pleasure plenty plot plug plus pocket poem poet point police policy
  polite political politics poll pool poor poorly pop popular population port portion position positive possess
  possibility possible possibly post pot potential potentially pound pour power powerful practical practically
  practice practise praise predict prefer preference premium preparation prepare presence present presentation
  preserve president press pressure pretend pretty prevent preview previous previously price pride primarily primary
  prime principal principle print prior priority prison privacy private privately prize probably problem problems
  procedure proceed process produce product production profession professional professor profile profit program
  programme progress project promise promote promotion prompt promptly proof proper properly property proposal
  propose pros prospect protect protection protocol proud prove provide provider proxy public publicly publish pull
  punish purchase pure purely purpose push put qualify quality quantity quarter quarterly query question questions
  queue quick quickly quiet quietly quit quite quote race radical radio raise random randomly range rapid rapidly
  rare rarely rate rather ratio raw reach react reaction read reader readily reading ready real realise realistic
  reality realize really reason reasonable reasonably recall recap receipt receive recent recently reception recipe
  recognise recognition recognize recommend recommendation recommendations record recording recover recovery reduce
  reduction refer reference reflect reflection refuse regard regarding region regional register regular regularly
  regulation reject relate related relation relationship relative relatively relax release relevant reliable relief
  religion rely remain remarkable remember remind reminder remote remove rename render renew rent repair repeat
  repeatedly replace replacement reply report reporter repository represent representative reputation request require
  requirement requirements rescue research reserve reset resident resist resolution resolve resource respect respond
  response responsibility responsible rest restart restaurant restore restrict result results retain retire
  retirement retry return reuse reveal revenue review revise reward rice rich ride right ring rise risk risks road
  role roll roof room rough roughly round route router routine row rule run runtime rural rush sad sadly safe safely
  safety salad salary sale sales salt same sample sandbox sandwich satisfaction satisfy save saving scale scan scene
  schedule schema scheme scholar school science scope score screen script search season seat second secondary secret
  secretary section sector secure security see seek seem select selection self sell seller send senior sense
  sensitive sentence separate separately sequence series serious seriously serve server service session set setting
  settle setup seven several severe shadow shake shall shape share sharp sheet shift shirt shock shoe shoot shop
  shopping short shortly shot should shoulder shout show shut sick side sign signal significant significantly silent
  silly similar similarly simple simply since sing single sink sister sit site situation six size skill skin sky
  sleep slide slight slightly slip slow slowly small smart smell smile smooth snapshot social society soft software
  soil solid solution solutions solve somebody somehow someone something sometimes somewhat somewhere son song soon
  sorry sort sound soup source south southern space spare speak speaker special specific specifically speech speed
  spend spirit split sport spot spread spring staff stage stake stand standard start state statement station status
  stay steady steal step steps stick still stock stomach stop storage store story straight strange stranger strategy
  stream street strength stress stretch strict strictly strike string strong strongly structure struggle student
  studio study stuff stupid style subject submission submit subscription subsequent subsequently substantial succeed
  success successful successfully such sudden suddenly suffer sufficient sugar suggest suggestion suit suitable
  summary supply support suppose sure surely surface surgery surprise surprised surprising surprisingly surround
  survey survive suspect sweet swim switch symptom sync syntax system table take tale talk tall task taste tax taxi
  tea teach teacher teaching team tear technical technique technology teenager telephone television tell temperature
  template temporarily temporary ten tend tennis term terminal terrible terribly test testing text thank thanks theme
  themselves theory therefore thick thin thing think third thirty thorough thought thousand thread threat three
  throat throughout throw thus ticket tie tight till time timeline tiny tip tired title today todo toe together token
  tomorrow tone tonight tool tooth top topic total totally touch tough tour toward towards town track trade tradeoff
  tradeoffs tradition traditional traffic train training transaction transfer transform transition translate
  transport travel treat treatment tree trend trial trick trigger trip trouble truck true truly trust truth try tune
  turn tutorial twelve twenty twice two type typical typically ugly ultimately unable uncle under understand
  understanding unexpected unexpectedly unfortunately uniform union unique unit university unknown unless unlike
  unlikely unlock until unusual update updates upgrade upload upon upper upset upstairs urban urge urgent urgently
  usage use used useful user usual usually vacation valid validate valuable value variable variety various vast
  vehicle vendor verification verify version very via video view village virtual virtually virus visible vision visit
  visitor visual vital voice volume vote wage wait wake walk wall want war warm warn warning wash waste watch water
  wave way weak wealth wear weather web website wedding week weekend weekly weigh weight welcome well west western
  wet whatever wheel whenever wherever whether whichever while whoever whole wide widely widget wife wild willing win
  wind window wine winner winter wise wish within without witness woman wonder wonderful word work worker workflow
  working workshop workspace world worldwide worried worry worse worst worth would write writer writing wrong yard
  yeah year yearly yesterday youth zero zone
  `
    .split(/\s+/)
    .filter(Boolean),
)

// Usual endings, each with what the word was before it: "companies" was "company", "planned" was "plan".
const ENDINGS: readonly (readonly [RegExp, string])[] = [
  [/ies$/, "y"],
  [/ied$/, "y"],
  [/ily$/, "y"],
  [/es$/, ""],
  [/s$/, ""],
  [/ed$/, ""],
  [/d$/, ""],
  [/ing$/, ""],
  [/ing$/, "e"],
  [/([b-df-hj-np-tv-z])\1(?:ed|ing)$/, "$1"],
  [/ly$/, ""],
]

/** Whether a lower-case word is a common English word, or one with a usual ending. */
export function common(word: string) {
  return (
    WORDS.has(word) ||
    ENDINGS.some(([ending, stem]) => {
      const form = word.replace(ending, stem)
      return form !== word && form.length >= 3 && WORDS.has(form)
    })
  )
}
