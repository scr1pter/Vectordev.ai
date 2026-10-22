export * as ResearchEnglish from "./english"

// Common English words, for telling a sentence's ordinary first word from a name. "Heat pumps are loud" opens with a
// word, "Kestrel ships in May" with a name: a sentence capitalises its first word either way, so only the word itself
// can tell them apart. This holds everyday nouns, verbs, adjectives and adverbs of the kind notes, documents and
// remembered facts open with. It leaves out rarer words (kestrel, umbrella, falcon), since a code name or a company is
// often one of those, and a word missing here costs only a refusal until the user types it. Function words, months and
// days are in the outbound check's own list; the verbs among them are here too, so "Getting" and "Makes" are read.
const WORDS = new Set(
  `ask avoid check decide find get give go keep let like make prefer see set take try use want
  acknowledgements acknowledgments appendix changelog contributing faq glossary installation intro motivation
  overview prerequisites quickstart readme todo troubleshooting tutorial
  attendee backlog churn commute contributor dislike downtime headcount installer kickoff latency maintainer
  observability offboarding reimbursement researcher respondent reviewer rollback rollout runway standup subscriber
  throughput upsell uptime
  ability absence academic accept access accident according account accounting accurate achieve acid acquire act
  action active activity actor actual actually ad add addition additional address adjust admin administration admit
  adopt adult advance advanced advantage adventure advertising advice advise affair affect afford afraid afternoon age
  agency agenda agent agree agreement ahead aid aim air aircraft airline airport alarm album alcohol alert alive allow
  alone along alternative amazing amount analyse analysis analyst analytics analyze ancient anger angle angry animal
  announce annual answer anxiety anybody anyway anywhere apart apartment app apparent apparently appeal appear
  application apply appointment appreciate approach appropriate approval approve architecture area argue argument arm
  army arrange arrangement arrival arrive art article artist aside aspect assess assessment asset assign assignment
  assist assistance assistant associate association assume attach attack attempt attend attention attitude attract
  audience audio audit author authority auto automatic available average avoid award aware away awful baby back
  background backup bad badly bag bake balance ball ban band bank bar base baseline basic basically basis basket bath
  battery battle beach bean bear beat beautiful beauty become bed bedroom beer begin beginning behave behavior
  behaviour behind belief believe belong beneath benefit beside besides beyond bid big bike bill billing billion bind
  bird birth birthday bit bite bitter black blame blank block blog blood blow blue board boat body boil bold bone bonus
  book booking boost boot border bored boring born borrow boss bother bottle bottom bound bowl box boy brain branch
  brand brave bread break breakfast breath breathe brief briefly bright brilliant bring broad broadcast broken brother
  brown browser brush budget bug build builder building bunch burn bus business busy butter button buy buyer cable
  cache cake calculate calendar call calm camera camp campaign campus cancel cancer candidate cap capable capacity
  capital captain capture car carbon card care career careful carefully carry case cash cast cat catch category cause
  celebrate cell center central centre century certain certainly chain chair chairman challenge champion chance change
  channel chapter character charge chart chase cheap check checklist cheese chemical chemistry chicken chief child
  childhood chip chocolate choice choose church circle citizen city civil claim class classic classroom clean clear
  clearly clever click client climate climb clinic clock close closely clothes cloud club cluster coach coal coast coat
  code coffee cold collapse colleague collect collection college colour color column combination combine come comfort
  comfortable command comment commercial commission commit commitment committee common communicate communication
  community company compare comparison compete competition competitive complain complaint complete completely complex
  compliance component computer concept concern concerned concert conclude conclusion condition conduct conference
  confidence confident config configuration confirm conflict confused connect connection conscious consequence
  consider considerable consist consistent constant constantly construct construction consult consultant consumer
  contact contain container content contest context continue contract contractor contrast contribute contribution
  control convention conversation convert convince cook cookie cool cooperation copy core corner corporate correct
  cost cottage cotton could council count counter country county couple courage course court cousin cover coverage
  crash crazy cream create creative credit crew crime criminal crisis criteria critical criticism crop cross crowd
  crucial cry cultural culture cup curious currency current currently curve custom customer cut cute cycle dad daily
  damage dance danger dangerous dark dashboard data database date daughter dead deadline deal dear death debate debt
  debug decade decent decide decision deck declare decline deep deeply default defeat defence defense defend define
  definitely definition degree delay delete deliver delivery demand demo democracy democratic demonstrate deny
  department depend dependency deploy deployment deposit depth describe description desert deserve design designer
  desire desk desktop desperate despite destroy detail detailed detect determine develop developer development device
  diet differ difference different difficult difficulty digital dinner direct direction directly director dirty
  disagree disappear discount discover discovery discuss discussion disease dish display distance distinct
  distribute distribution district divide doctor document documentation dog dollar domain domestic door double doubt
  down download downstairs dozen draft drag drama dramatic draw drawing dream dress drink drive driver drop drug dry
  due dull dust duty eager earn earnings earth easily east eastern easy eat economic economics economy edge edit
  edition editor educate education effect effective effectively efficiency efficient effort egg eight eighteen eighty
  elderly elect election electric electrical electricity electronic element elevator eleven eligible elsewhere email
  embrace emerge emergency emission emissions emotion emotional emphasis employ employee employer employment empty
  enable encourage end ending enemy energy engage engine engineer engineering enhance enjoy enormous enough ensure
  enter enterprise entertainment entire entirely entrance entry environment environmental episode equal equally
  equipment error escape especially essay essential essentially establish estate estimate evaluate evaluation evening
  event eventually evidence evil exam examination examine example excellent except exchange excited exciting excuse
  executive exercise exist existing exit expand expansion expect expectation expense expenses expensive experience
  experiment expert explain explanation explore export expose express expression extend extension extent external
  extra extreme extremely eye fabric face facility fact factor factory fail failure fair fairly faith fall false
  familiar family famous fan fancy fantastic far farm farmer fashion fast fat father fault favour favor favourite
  favorite fear feature federal fee feed feedback feel feeling fellow female fence festival fetch fever field fifteen
  fifth fifty fight figure file fill film final finally finance financial finding fine finger finish fire firm firmly
  fish fit fitness five fix fixed flag flat flight float floor flow flower fly focus fold folder folk follow following
  food fool foot football force forecast foreign forest forever forget forgive form formal format former formula forth
  fortunately fortune forty forum forward found foundation founder four fourteen fourth frame free freedom freeze
  frequent frequently fresh friend friendly friendship front frontend fruit frustrated fuel full fully fun function
  fund funding funny furniture further future gain game gap garage garden gas gate gather gear general generally
  generate generation generous gentle gently genuine gift girl glad glass global goal gold golden golf goods govern
  government grab grade gradually graduate grain grand grandfather grandmother grant graph grass grateful gray green
  grey grocery groceries ground group grow growing growth guarantee guard guess guest guidance guide guideline guilty
  guitar gun guy gym habit hair half hall hand handle hang happen happy hard hardly hardware harm hat hate head
  headline health healthy hear hearing heart heat heating heavy height hello help helpful hence here hero hesitate hi
  hide high highlight highly highway hill hire historic historical history hit hobby hold holder hole holiday home
  homework honest honestly hope horrible horse hospital host hot hotel hour house household housing huge human humor
  humour hundred hungry hunt hurry hurt husband ice idea ideal identify identity ignore ill illegal illness image
  imagine immediate immediately impact implement implication imply import importance important impose impossible
  impress impression impressive improve improvement incident include including income increase increasingly incredible
  indeed independent index indicate individual industrial industry infant infection inflation influence inform
  informal information infrastructure initial initially initiative injury inner innocent input inquiry insert inside
  insight insist inspect inspection install instance instant instead institute institution instruction instrument
  insurance intelligence intelligent intend intense intention interest interested interesting interface internal
  international internet interpret interval interview introduce introduction invest investigate investigation
  investment investor invitation invite invoice involve iron island issue item itself jacket job join joint joke
  journal journey joy judge judgement judgment juice jump junior jury justice justify keen key kick kid kill kind king
  kitchen knee knife knock know knowledge lab label labour labor lack lady lake land landscape language laptop large
  largely last late lately later latest laugh launch law lawyer lay layer lazy lead leader leadership leading league
  lean learn learning lease leather leave lecture left leg legal legend lemon lend length lesson letter level library
  licence license lie life lifestyle lift light likely limit limited line link lip liquid list listen literally
  literature little live lively living load loan local locate location lock log logic login lonely long longer look
  loose lose loss lost lot lots loud love lovely low lower luck lucky lunch machine mad magazine magic mail main
  mainly maintain maintenance major majority male mall man manage management manager manner manual manufacturer map
  margin mark market marketing marriage married mass massive master match mate material math maths matter maximum meal
  mean meaning meanwhile measure measurement meat media medical medicine medium meet meeting member membership memory
  mental mention menu mere merely merge mess message metal method metric metrics middle midnight might migrate
  migration mild mile military milk million mind minimum minister minor minute minutes mirror miss missing mission
  mistake mix mixed mobile mode model modern module mom moment money monitor monthly mood moon moral moreover morning
  mortgage mostly mother motion motor mountain mouse mouth move movement movie moving mum murder muscle museum music
  musical myself nail name narrow nation national native natural naturally nature near nearby nearly neat necessarily
  necessary neck need negative neighbour neighbor neighbourhood neighborhood neither nephew nervous net network neutral
  nevertheless news newspaper nice niece night nine nineteen ninety nobody nod noise none nonetheless normal normally
  north northern nose nothing notice novel nowhere number nurse object objective obligation observe obtain obvious
  obviously occasion occasionally occur ocean odd offer office officer official oil ok okay onboarding one online open
  opening operate operation operator opinion opponent opportunity oppose opposite option optional orange order
  ordinary organic organisation organise organization organize origin original originally otherwise outage outcome
  outline output outside outstanding overall overcome owe owner pace pack package page pain paint painting pair pale
  pan panel paper parent park parking part participant participate particular particularly partly partner party pass
  passage passenger passion password past patch path patience patient pattern pause pay payment payroll peace peak pen
  penalty pension people pepper percentage perfect perfectly perform performance period permanent permission person
  personal personally perspective phase phone photo photograph phrase physical physics piano pick picture pie piece
  pilot pin pink pipe pipeline pitch pizza place plain plan plane planet planning plant plastic plate platform play
  player pleasant pleased pleasure plenty plot plug plus pocket poem poet point police policy polite political
  politics pool poor pop popular population port portion position positive possess possession possibility possible
  possibly post pot potato potential potentially pound pour poverty powder power powerful practical practice practise
  praise pray predict prediction preference pregnant premium preparation prepare present presentation preserve
  president press pressure pretend pretty prevent previous previously price pricing pride priest primarily primary
  prime prince principal principle print printer prior priority prison privacy private prize probably problem
  procedure proceed process produce producer product production profession professional professor profile profit
  program programme progress project promise promote promotion prompt proof proper properly property proposal propose
  prospect protect protection protein protest proud prove provide provider province public publication publish pull
  pump punch purchase pure purple purpose pursue push put qualify quality quantity quarter queen query question queue
  quick quickly quiet quietly quite quote race radio rail rain raise random range rank rapid rapidly rare rarely rate
  ratio raw reach react reaction read reader reading ready real realise realistic reality realize really reason
  reasonable rebuild recall receipt receive recent recently recipe recognise recognition recognize recommend
  recommendation record recording recover recovery recruit red reduce reduction refer reference reflect reflection
  reform refund refuse regard region regional register regret regular regularly regulation reject relate relation
  relationship relative relatively relax release relevant reliable relief religion religious rely remain remark
  remarkable remember remind remote remove rename renew renewal rent repair repeat replace replacement reply report
  reporter repository represent representative reputation request require requirement research reserve reset
  resident resign resist resolve resource respect respond response responsibility responsible rest restaurant restore
  restrict result retail retain retention retire retirement retry return reveal revenue review revolution reward rice
  rich rid ride right ring rise risk river road roadmap rock role roll romantic roof room root rough round route
  routine row royal rub rubbish rude ruin rule run running rural rush sad safe safety salad salary sale sales salt
  same sample sand satisfaction satisfied satisfy sauce save saving savings scale scan scare scared scenario scene
  schedule scheme scholar school science scientific scientist score screen script sea search season seat second
  secondary secret secretary section sector secure security seek seem select selection self sell seller send senior
  sense sensitive sentence separate sequence series serious seriously servant serve server service session setting
  settle setup seven seventeen seventy severe sex shade shadow shake shall shame shape share sharp shelf shell shift
  shine ship shirt shock shoe shoot shop shopping shore short shortly shot shoulder shout show shower shut shy sick
  side sight sign signal signature significant significantly silence silent silly silver similar similarly simple
  simply sing singer single sink sir sister sit site situation six sixteen sixty size skill skin skirt sky sleep slice
  slide slight slightly slip slow slowly small smart smell smile smoke smooth snack snow soap social society sock soft
  software soil solar soldier solid solution solve somebody somehow someone something somewhat somewhere son song
  sorry sort soul sound soup source south southern space spare speak speaker special specialist species specific
  specifically speech speed spell spend spending spin spirit spiritual split spokesperson sponsor spot spread spring
  sprint square stable staff stage stair stake stand standard star stare start state statement station status stay
  steady steal steel step stick stock stomach stone stop storage store storm story straight strange stranger strategy
  stream street strength stress stretch strict strike string strip strong strongly structure struggle student studio
  study stuff stupid style subject submit subscription subsequent substance subtle succeed success successful
  successfully sudden suddenly suffer sufficient sugar suggest suggestion suit suitable summary summer sun super
  supermarket supplier supply support supporter suppose sure surely surface surgery surprise surprised surprising
  surround survey survival survive suspect sweet swim swing switch symbol sympathy system table tackle tag tail tale
  talent talk tall tank tap target task taste tax taxes tea teach teacher teaching team tear technical technique
  technology teenager telephone television tell temperature temporary ten tend tendency tennis tension term terminal
  terrible terribly territory test testing text thank theme theory therapy therefore thick thin thing think thinking
  third thirteen thirty thought thousand threat threaten three throat throw thus ticket tidy tie tight till timber time
  timeline tiny tip tired title toast toe toilet token tomato tone tongue tonight tool tooth top topic total totally
  touch tough tour tourist toward towards towel tower town toy track trade tradition traditional traffic train trainer
  training transfer transform transition translate transport trap travel treat treatment tree trend trial trick trip
  trouble truck true truly trust truth tube tune turn twelve twenty two type typical typically ugly ultimate
  ultimately unable uncle understand understanding unemployment unfortunately unhappy uniform union unique unit unite
  united unity universal universe university unknown unlikely unlock unusual update upgrade upload upon upper upset
  upstairs urban urge urgent usage useful user usual utility vacation valid valley valuable value van variable
  variation variety various vast vegetable vehicle vendor venture version versus via victim victory video view viewer
  village violence virtual virus visible vision visit visitor visual vital voice volume volunteer vote voter wage wait
  waiter wake walk wall wander war warm warmth warn warning wash waste watch water wave way weak weakness wealth
  wealthy weapon wear weather web website wedding week weekend weigh weight weird welcome welfare well west western wet
  whatever wheel whenever wherever whisper white whoever whole wide widely wife wild willing win wind window wine wing
  winner winter wire wise wish witness woman wonder wonderful wood wooden word work worker workflow working workout
  workshop world worried worry worse worst worth worthy wound wrap write writer writing wrong yard yeah year yellow
  yesterday yoga young youth zero zone`
    .split(/\s+/)
    .filter(Boolean),
)

/** Whether a word, or the word it is a plural or another form of, is a common English word. */
export function common(word: string) {
  const lower = word.toLowerCase()
  return [
    lower,
    lower.replace(/s$/, ""),
    lower.replace(/es$/, ""),
    lower.replace(/ies$/, "y"),
    lower.replace(/ied$/, "y"),
    lower.replace(/ed$/, ""),
    lower.replace(/d$/, ""),
    lower.replace(/ing$/, ""),
    lower.replace(/ing$/, "e"),
    lower.replace(/(\p{Ll})\1(?:ed|ing)$/u, "$1"),
    lower.replace(/ly$/, ""),
    lower.replace(/ily$/, "y"),
  ].some((form) => WORDS.has(form))
}
