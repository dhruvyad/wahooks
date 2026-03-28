package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/dhruvyad/wahooks/cli/internal/api"
	"github.com/dhruvyad/wahooks/cli/internal/auth"
	"github.com/dhruvyad/wahooks/cli/internal/config"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

var (
	cfg     *config.Config
	client  *api.Client
	version = "dev"
)

func SetVersion(v string) { version = v }

// ─── Lipgloss styles ────────────────────────────────────────────────────

var (
	cyan  = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
	faint = lipgloss.NewStyle().Faint(true)
	bold  = lipgloss.NewStyle().Bold(true)
)

// ─── Command groups ─────────────────────────────────────────────────────

type commandGroup struct {
	title    string
	commands []string
}

var rootGroups = []commandGroup{
	{"Commands", []string{"login", "status", "health"}},
	{"Connections", []string{"connections"}},
	{"Webhooks", []string{"webhooks"}},
	{"Billing", []string{"billing"}},
	{"Tokens & Config", []string{"tokens", "config"}},
	{"Integrations", []string{"claude"}},
	{"Testing", []string{"e2e"}},
}

// ─── Root command ───────────────────────────────────────────────────────

var rootCmd = &cobra.Command{
	Use:           "wahooks",
	Short:         "WAHooks CLI — manage WhatsApp connections, webhooks, and billing",
	Version:       version,
	SilenceUsage:  true,
	SilenceErrors: true,
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		cfg = config.Load()

		if url, _ := cmd.Flags().GetString("api-url"); url != "" {
			cfg.APIURL = url
		}

		client = api.NewClient(cfg.APIURL, cfg.Token)

		if cfg.RefreshToken != "" {
			refreshToken := cfg.RefreshToken
			client.TokenRefresher = func() (string, string, error) {
				result, err := auth.Refresh(refreshToken)
				if err != nil {
					return "", "", err
				}
				refreshToken = result.RefreshToken
				return result.AccessToken, result.RefreshToken, nil
			}
			client.OnTokenRefresh = func(accessToken, newRefreshToken string) {
				cfg.Token = accessToken
				cfg.RefreshToken = newRefreshToken
				_ = cfg.Save()
			}
		}
	},
}

func Execute() {
	rootCmd.TraverseChildren = true
	if err := rootCmd.Execute(); err != nil {
		// Find the command that failed to show its usage
		target, _, _ := rootCmd.Find(os.Args[1:])
		hint := ""
		if target != nil && target != rootCmd {
			hint = "Usage: " + target.UseLine()
		}
		renderErrorPanel(err.Error(), hint)
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().String("api-url", "", "API base URL (default: from config)")
	rootCmd.SetHelpFunc(styledHelp)
}

// ─── Styled help rendering ─────────────────────────────────────────────

func styledHelp(cmd *cobra.Command, _ []string) {
	if cmd == rootCmd {
		renderRootHelp(cmd)
	} else {
		renderSubcommandHelp(cmd)
	}
}

func renderRootHelp(cmd *cobra.Command) {
	titleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("2")).Bold(true)
	versionStyle := lipgloss.NewStyle().Faint(true)

	fmt.Println()
	fmt.Printf(" %s %s\n", titleStyle.Render("WAHooks CLI"), versionStyle.Render("v"+version))
	fmt.Println()
	fmt.Printf(" %s\n", faint.Render("WhatsApp webhooks, instant setup."))
	fmt.Printf(" See %s for docs.\n", cyan.Render("https://wahooks.com/docs"))
	fmt.Println()
	fmt.Printf(" %s\n", bold.Render("Usage:"))
	fmt.Printf("   wahooks %s\n", faint.Render("[command]"))
	fmt.Println()

	for _, g := range rootGroups {
		cmds := findCommands(cmd, g.commands)
		if len(cmds) == 0 {
			continue
		}
		renderGroupBox(g.title, cmds)
	}

	renderFlagsBox(cmd)
	fmt.Println()
}

func renderSubcommandHelp(cmd *cobra.Command) {
	fmt.Println()
	fmt.Printf(" %s\n", bold.Render(cmd.UseLine()))
	if cmd.Short != "" {
		fmt.Println()
		fmt.Printf(" %s\n", cmd.Short)
	}
	fmt.Println()

	if cmd.HasAvailableSubCommands() {
		var cmds []cmdEntry
		for _, sub := range cmd.Commands() {
			if sub.Hidden || sub.Name() == "help" || sub.Name() == "completion" {
				continue
			}
			name := sub.Name()
			if len(sub.Aliases) > 0 {
				name += faint.Render(" (" + strings.Join(sub.Aliases, ", ") + ")")
			}
			cmds = append(cmds, cmdEntry{name: name, nameLen: len(sub.Name()), desc: sub.Short})
		}
		renderGroupBox("Commands", cmds)
	}

	renderFlagsBox(cmd)
	fmt.Println()
}

type cmdEntry struct {
	name    string // may contain ANSI (aliases)
	nameLen int    // visible length (without aliases)
	desc    string
}

func findCommands(parent *cobra.Command, names []string) []cmdEntry {
	var result []cmdEntry
	for _, name := range names {
		for _, sub := range parent.Commands() {
			if sub.Name() == name && !sub.Hidden {
				display := sub.Name()
				displayLen := len(sub.Name())
				if len(sub.Aliases) > 0 {
					display += faint.Render(" (" + strings.Join(sub.Aliases, ", ") + ")")
				}
				result = append(result, cmdEntry{name: display, nameLen: displayLen, desc: sub.Short})
			}
		}
	}
	return result
}

func renderGroupBox(title string, cmds []cmdEntry) {
	// Find max name width for alignment
	maxName := 0
	for _, c := range cmds {
		if c.nameLen > maxName {
			maxName = c.nameLen
		}
	}

	// Build the content lines
	var lines []string
	for _, c := range cmds {
		padding := strings.Repeat(" ", maxName-c.nameLen)
		lines = append(lines, fmt.Sprintf(" %s%s   %s", c.name, padding, faint.Render(c.desc)))
	}

	content := strings.Join(lines, "\n")

	titleStyled := lipgloss.NewStyle().Foreground(lipgloss.Color("6")).Bold(true).Render(title)

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("8")).
		Padding(0, 1).
		Width(74).
		Render(content)

	boxLines := strings.Split(box, "\n")
	if len(boxLines) > 0 {
		borderColor := lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
		dashes := 74 - len(title) - 3
		if dashes < 0 {
			dashes = 0
		}
		boxLines[0] = borderColor.Render("╭─") + " " + titleStyled + " " + borderColor.Render(strings.Repeat("─", dashes)+"╮")
	}

	for _, l := range boxLines {
		fmt.Println(" " + l)
	}
}

func renderFlagsBox(cmd *cobra.Command) {
	flags := cmd.LocalFlags()
	if cmd == rootCmd {
		flags = cmd.Flags()
	}

	type flagEntry struct {
		name  string
		usage string
	}
	var entries []flagEntry

	flags.VisitAll(func(f *pflag.Flag) {
		if f.Hidden {
			return
		}
		n := "--" + f.Name
		if f.Shorthand != "" {
			n = "-" + f.Shorthand + ", " + n
		}
		entries = append(entries, flagEntry{name: n, usage: f.Usage})
	})

	// Don't duplicate --help since Cobra already adds it

	if len(entries) == 0 {
		return
	}

	maxName := 0
	for _, e := range entries {
		if len(e.name) > maxName {
			maxName = len(e.name)
		}
	}

	var lines []string
	for _, e := range entries {
		padding := strings.Repeat(" ", maxName-len(e.name))
		lines = append(lines, fmt.Sprintf(" %s%s   %s", e.name, padding, faint.Render(e.usage)))
	}

	content := strings.Join(lines, "\n")

	titleStyled := lipgloss.NewStyle().Foreground(lipgloss.Color("6")).Bold(true).Render("Options")

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("8")).
		Padding(0, 1).
		Width(74).
		Render(content)

	boxLines := strings.Split(box, "\n")
	if len(boxLines) > 0 {
		borderColor := lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
		titlePlain := "Options"
		dashes := 74 - len(titlePlain) - 3
		if dashes < 0 {
			dashes = 0
		}
		boxLines[0] = borderColor.Render("╭─") + " " + titleStyled + " " + borderColor.Render(strings.Repeat("─", dashes)+"╮")
	}

	for _, l := range boxLines {
		fmt.Println(" " + l)
	}
}

func renderErrorPanel(msg string, hint string) {
	titleStyled := lipgloss.NewStyle().Foreground(lipgloss.Color("1")).Bold(true).Render("Error")

	content := " " + msg
	if hint != "" {
		content += "\n\n " + faint.Render(hint)
	}

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("1")).
		Padding(0, 1).
		Width(74).
		Render(content)

	boxLines := strings.Split(box, "\n")
	if len(boxLines) > 0 {
		borderColor := lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
		dashes := 74 - len("Error") - 3
		boxLines[0] = borderColor.Render("╭─") + " " + titleStyled + " " + borderColor.Render(strings.Repeat("─", dashes)+"╮")
	}

	for _, l := range boxLines {
		fmt.Fprintln(os.Stderr, l)
	}
}
