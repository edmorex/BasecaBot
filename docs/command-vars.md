# Supported Custom Command Variables
Variables are placeholders that can be used in chat commands to represent a specific value or piece of information. When a command is triggered, these variables are replaced with the actual values they represent.

Variables are encapsulated with `$()` or `${}`. Both syntaxes are interchangeable. Variables may be nested, and their arguments may be quoted or contain other variables (evaluated inner-first). An unknown variable or a missing value resolves to an empty string, and a variable that errors is swallowed silently — a bad template never breaks the command.

## $(args) Variables
Accesses the arguments a user passed to the command. Individual arguments are accessed by 1-based numeric index. Accessing an argument that wasn't supplied yields an empty string.

### $(args)
All arguments passed to the command.

**Example:**

`Command: !echo input was: $(args)`

**Input:**

`!introduce hello world`

**Output:**

`input was: hello world`


### $(args.n) or $(1), $(2), $(3), ...
The nth argument.

**Example:**

`Command: !introduce $(1) is $(2) years old`

**Input:**

`!introduce Alice 25`

**Output:**

`Alice is 25 years old`

### ${n:} or ${n:m}
A slice of the arguments: `${n:}` is arguments *n* through the end; `${n:m}` is arguments *n* up to (but not including) *m*. 1-based.

**Example:**

`Command: !search results for: ${1:}`

**Input:**

`!search funny cat videos`

**Output:**

`results for: funny cat videos`

### $(n.emote)
Outputs argument *n* only if it is a valid emote.

**Example:**

`Command: !emote $(1.emote)`

**Input:**

`!emote Kappa`

**Output:**

`Kappa`

### $(n.word)
Outputs argument *n* only if it contains no symbols.

**Example:**

`Command: !word $(1.word)`

**Input:**

`!word Hello`

**Output:**

`Hello`

## $(channel) Variables
The $(channel) variables allow you to access and display various channel-related information. These variables provide real-time data.

### $(channel)
Displays the name of the channel.

**Example:**

`Welcome to $(channel)!`

**Output:**

`Welcome to basecampfoster!`

### $(channel.viewers)
Shows the current viewer count. Returns "not live" if offline.

**Example:**

`We currently have $(channel.viewers) viewers!`

**Output:**

`We currently have 1337 viewers!`

### $(channel.followers)
Displays the total follower count.

**Example:**

`Thank you to our $(channel.followers) amazing followers!`

**Output:**

`Thank you to our 50000 amazing followers!`

### $(channel.display_name)
Shows the channel's display name, which may differ in capitalization.

**Example:**

`You're watching $(channel.display_name)'s stream!`

**Output:**

`You're watching BasecampFoster's stream!`

### $(channel.title)
Displays the current stream title or status.

**Example:**

`Current stream title: $(channel.title)`

**Output:**

`Current stream title: Speedrunning Mario 64 - Day 3!`

### $(channel.game)
Shows the current game being played. Returns "no game" if not set.

**Example:**

`We're currently playing: $(channel.game)`

**Output:**

`We're currently playing: Super Mario 64`

### $(channel.uptime)
Shows the current stream uptime. Returns "not live" if offline.

**Example:**

`We've been live for: $(channel.uptime)`

**Output:**

`We've been live for: 3 hours 27 minutes`

## $(count)
Returns the new use count of a !command.

**Alias:** `$(getcount)`

**Syntax:** `$(count [!commnad])`

**Parameters:**
- `!command` (optional): The !command's count that should be returned. Defaults to the name of the current command the variable is being use in.

**Example (a death count that would increase):**

`!death the death count is now $(count)`

**Example (a printout of the death count without increasing):**

`!current_deaths the death count is currently at $(count !death)`

## $(default) / $(first)
Returns the first of its arguments that isn't empty — a "use this, otherwise
that" fallback. `$(first)` is a synonym for `$(default)`.

**Syntax:** `$(default <value1> <value2> [value3 …])`

**Parameters:**
- One or more values, checked left to right. The first non-empty one is returned;
  if all are empty, the result is empty. Values are usually other variables (an
  argument, `$(sender)`, `$(game)`, …) or literal text.

**Example (address the given user, or the sender if none was given):**

`!compliment Hey $(default $(1) $(sender)), you're doing great!`

**Output:**

`!compliment` → `Hey Styler, you're doing great!`
`!compliment Alice` → `Hey Alice, you're doing great!`

**Example (a literal fallback):**

`Now playing $(default $(game) "something fun")`

> **Multi-word values must be quoted.** Each value is treated as a single token,
> so a fallback phrase with spaces needs quotes (`"something fun"`), and to keep
> spaces from a multi-word variable, quote it too: `$(default "$(args)" "nothing")`.

> **Tip:** for the common "address a user or the sender" case you can also just
> use `$(user $(1))` — the `$(user …)` variable already falls back to the sender
> when no name is given (see [$(user) Variables](#user-variables)).

## $(game)
Displays the game/category currently set on a channel.

**Syntax:** `$(game [username])`

**Parameters:**
- `username` (optional): the channel to query. Defaults to the current channel.

**Example:**

`Current game: $(game)`

**Output:**

`Current game: Valorant`

**Example (another channel):**

`$(user) is playing: $(game shroud)`

**Output:**

`shroud is playing: Counter-Strike: Global Offensive`


## $(math)
Evaluates a math.js expression and substitutes in the result. Other variables may be embedded in the expression.

**Syntax:** `$(math <expression>)`

Supports arithmetic (`+ - * /`), functions (`round()`, `floor()`, `ceil()`, `log()`, `sin()`, `cos()`, ...), constants (`pi`, `e`), and comparison operators (`>`, `<`, `==`, `!=`).

**Example:**

`10 divided by 3, rounded to the nearest integer, is $(math "round(10/3)")`

**Output:**

`10 divided by 3, rounded to the nearest integer, is 3`


## $(pathescape)
URL-encodes a string so it is safe to embed in a URL *path*. Spaces and reserved characters are percent-encoded. Returns an error if no string is given.

**Syntax:** `$(pathescape <string>)`

**Example:**

`https://api.example.com/$(pathescape "User Input & Symbols?")`

**Output:**

`https://api.example.com/User%20Input%20%26%20Symbols%3F`

## $(pointsname)
Substitutes the channel's configured loyalty currency name. Takes no parameters.

**Example:**

`Earn more $(pointsname) by watching the stream!`

**Output (currency named "BasecaPoints"):**

`Earn more BasecaPoints by watching the stream!`

## $(queryescape)
URL-encodes a string for use in a *query string*. Spaces become plus signs and special characters are escaped.

**Syntax:** `$(queryescape <text>)`

**Example:**

`!command add !yt https://www.youtube.com/results?search_query=$(queryescape ${1:})`

**Input:** `!yt funny cat videos`

**Output:**

`https://www.youtube.com/results?search_query=funny+cat+videos`

## $(quote) Variables
Access saved quotes: display one, search for a random match, or count them.

### $(quote)
Returns a saved quote — random by default, or a specific one by ID.

**Syntax:** `$(quote [quoteID])`

**Parameters:**
- `quoteID` (optional): the quote to display. If omitted, a random quote is chosen.

**Example:**

`$(quote 3)`

### $(quote.search <searchTerm>)
Returns a random quote whose text contains `searchTerm`, or blank if none match.

**Alias:** `$(quote.about <searchTerm>)`

**Example:**

`$(quote.search pizza)`

### $(quote.searchuser <username>)
Returns a random quote attributed to `username`, or blank if none. The name may
be an @handle, display name, or alias; a multi-word name (e.g. a guest) is
matched as entered.

**Alias:** `$(quote.by <username>)`

**Example:**

`$(quote.by Sharon)`

### $(quote.count)
Returns the total number of saved quotes.

**Example:**

`We have $(quote.count) quotes on record!`

### $(quote.searchcount <searchTerm>)
Returns the number of quotes whose text contains `searchTerm`.

**Alias:** `$(quote.aboutcount <searchTerm>)`

**Example:**

`$(quote.searchcount pizza) quotes mention pizza.`

### $(quote.searchusercount <username>)
Returns the number of quotes attributed to `username`.

**Alias:** `$(quote.bycount <username>)`

**Example:**

`$(quote.searchusercount Sharon) quotes are attributed to Sharon.`

## $(random) Variables
The random variables generate randomized content: numbers, emotes, chatters, and picks from a list.

### $(random) / $(random.number)
Generates a random number between two bounds, both inclusive.

**Syntax:** `$(random X-Y)` or `$(random.number X-Y)`

**Parameters:**
- `X`: lower bound (inclusive)
- `Y`: upper bound (inclusive)

**Example:**

`The dice roll is: ${random 1-6}`

### $(random.emote)
Returns a random emote from those available in the channel.

**Example:**

`Let's celebrate with $(random.emote)!`

### $(random.chatter)
Returns a randomly selected chatter from the current active chatters.

**Example:**

`Congratulations, $(random.chatter)! You've been selected!`

### $(random.pick)
Returns one randomly selected item from a supplied list. Items are single-quoted and space-separated.

**Syntax:** `$(random.pick 'item1' 'item2' 'item3' ...)`

**Example:**

`Today's special is: ${random.pick 'pizza' 'pasta' 'salad'}`

## $(repeat)
Repeats a phrase a given number of times. Wrap the phrase in quotes if it contains spaces or special characters. Nesting with other variables is supported.

**Syntax:** `$(repeat <number> <phrase>)`

**Parameters:**
- `number` (required): a positive integer.
- `phrase` (required): the text or variable to repeat.

**Example:**

`$(repeat 3 Kappa)`

**Output:**

`Kappa Kappa Kappa`

**Example (with a variable, triggered by "StreamerPro"):**

`$(repeat 2 "$(user) is awesome!")`

**Output:**

`StreamerPro is awesome! StreamerPro is awesome!`

## $(sender) Variables
The $(sender) variables always refer to the user who triggered the command, and never accept a username argument. To query an arbitrary user, use $(user) instead.

**Alias:** `$(source)`

### $(sender)
Displays the sender's display name.

**Example:**

`Current user: $(sender)`

**Output:**

`Current user: Styler`

### $(sender.name)
Displays the sender's display name, lowercased.

**Example:**

`Current user: $(sender.name)`

**Output:**

`Current user: styler`

### $(sender.points)
Displays the amount of loyalty currency the sender holds.

**Example:**

`$(sender) has $(sender.points) points`

**Output:**

`Styler has 100 points`


## $(time) Variables
The time variables display the current time in a given timezone, or a countdown to a future timestamp.

### $(time.timezone)
Displays the current time in the given timezone. Timezones must be given as IANA names (e.g. `America/New_York`, `Europe/London`); abbreviations such as EST or PST are not accepted. If no timezone is given, UTC is used.

**Syntax:** `$(time.timezone [timezone])`

**Example:**

`The current time in New York is $(time.timezone America/New_York)`

**Example (UTC):**

`The current UTC time is $(time.UTC)`

### $(time.until)
Displays a countdown to a target UTC timestamp in ISO 8601 format.

**Syntax:** `$(time.until <timestamp>)`

**Example:**

`Next stream starts in $(time.until 19:00)`

**Example (future date):**

`Upcoming event in $(time.until 2024-09-20T19:00:00-03:00)`

## $(title)
Displays a channel's current stream title.

**Syntax:** `$(title [username])`

**Parameters:**
- `username` (optional): the channel to query. Defaults to the current channel.

**Example:**

`!command add !title The current stream title is: $(title)`

**Output:**

`The current stream title is: Playing Spyro! Come join the adventure!`

## $(uptime)
Displays how long a stream has been live. Returns "not live" for an offline channel. The default format is "X hours Y minutes".

**Syntax:** `$(uptime [username])`

**Parameters:**
- `username` (optional): the streamer to query. Defaults to the current channel.

**Example:**

`The stream has been live for $(uptime).`

**Output:**

`The stream has been live for 2 hours 15 minutes.`

## $(user) Variables
The $(user) variables access user-related information: display names, loyalty points, ranks, and activity timestamps. Each accepts an optional username argument; without one, they refer to the user who triggered the command, behaving like $(sender).

- Without argument: `$(user)` refers to the command sender
- With argument: `$(user username)` refers to the named user

**Address an argument, or the sender if none was given:** pass `$(1)` as the
argument — `$(user $(1))`. When the command is used with no argument, `$(1)` is
empty and `$(user)` falls back to the sender:

`!hug $(sender) gives $(user $(1)) a big hug!`

`!hug` → `Styler gives Styler a big hug!` · `!hug Alice` → `Styler gives Alice a big hug!`

### $(user)
Displays the user's display name.

**Example:**

`Current user: $(user adeithe)`

**Output:**

`Current user: Adeithe`

### $(user.name)
Displays the user's display name, lowercased.

**Example:**

`Current user: $(user.name)`

**Output:**

`Current user: styler`

### $(user.points)
Displays the amount of loyalty currency the user holds.

**Example:**

`$(user adeithe) has $(user.points adeithe) points`

**Output:**

`Adeithe has 150 points`

## $(list) Variables
The $(list) variables access saved list infomation.

**Syntax:** `$(list <list_ref_name>)`

### $(list <list_ref_name>)
Displays the full name of a list.

**Example:**

`The gamesdone list is called $(list gamesdone)`

**Output:**

`The gamesdone list is called: Completed Games`

### $(list.n <list_ref_name>)
Displays the nth entry of the list.

**Example:**

`The 2nd game we beat was $(list.2 gamesdone)`

**Output:**

`The 2nd game we beat was Metal Gear`

### $(list.0 <list_ref_name>)
Displays a random entry of the list.

**Example:**

`Did you know we beat $(list.0 gamesdone)?`

**Output:**

`Did you know we beat Half-Life?`

### $(list.all <list_ref_name>)
Displays every entry of the list as a single comma-separated (CSV) line. Entries
that contain a comma or quote are quoted per CSV rules. Resolves to an empty
string if the list is unknown or has no entries.

**Aliases:** `$(list.dump)`, `$(list.show)`

**Example:**

`Games we've beaten: $(list.all gamesdone)`

**Output:**

`Games we've beaten: Half-Life,Metal Gear,"Portal 2, Co-op"`

