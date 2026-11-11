import { View, div } from "gpui-kit";
import { v_flex, h_flex, Button, TextView } from "gpui-base";
import { exec, theme } from "herdr";

const LIST_FIELDS = "number,title,url,repository,isDraft,updatedAt";
const DETAIL_FIELDS = "number,title,url,body,author,state,isDraft,headRefName,baseRefName,additions,deletions,changedFiles,reviewDecision,mergeable,statusCheckRollup,latestReviews,comments,createdAt,updatedAt";
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

export default class GitHubPRs extends View {
  init(_props, cx) {
    this.prs = [];
    this.request = 0;
    this.load(null, cx);
  }

  load(pr, cx) {
    const request = ++this.request;
    this.selected = pr;
    this.detail = null;
    this.error = null;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        // shortcut: latest 30 open authored PRs; add pagination if one page becomes insufficient.
        const args = pr
          ? ["pr", "view", pr.url, "--json", DETAIL_FIELDS]
          : ["search", "prs", "--author", "@me", "--state", "open", "--sort", "updated", "--order", "desc", "--limit", "30", "--json", LIST_FIELDS];
        if (pr && !PR_URL.test(pr.url)) throw new Error("Invalid GitHub pull request URL");
        const result = await exec("gh", args);
        if (result.code !== 0) throw new Error(result.stderr.trim() || "GitHub CLI request failed. Check gh auth status in a terminal.");
        const data = JSON.parse(result.stdout);
        if (pr) {
          if (!data || data.url !== pr.url || typeof data.title !== "string" || typeof data.body !== "string"
            || !Array.isArray(data.statusCheckRollup) || !Array.isArray(data.latestReviews) || !Array.isArray(data.comments)) {
            throw new Error("Unexpected pull request details from GitHub CLI");
          }
        } else if (!Array.isArray(data) || data.some(item => !item || !Number.isInteger(item.number)
          || typeof item.title !== "string" || typeof item.url !== "string" || !PR_URL.test(item.url)
          || typeof item.repository?.nameWithOwner !== "string")) {
          throw new Error("Unexpected pull request list from GitHub CLI");
        }
        if (request !== this.request) return;
        if (pr) this.detail = data;
        else this.prs = data;
      } catch (error) {
        if (request === this.request) this.error = error.message || String(error);
      } finally {
        if (request === this.request) { this.loading = false; cx.notify(); }
      }
    });
    cx.notify();
  }

  back(cx) {
    ++this.request;
    this.selected = null;
    this.detail = null;
    this.loading = false;
    this.error = null;
    cx.notify();
  }

  button(id, text, action, t) {
    return Button.new(id).h(28).px(8).flex().items_center().justify_center()
      .rounded(6).border(1).border_color(t.border).text_color(t.muted).text_size(12)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).focus(s => s.border_color(t.accent))
      .accessibility_label(text).on_click(action).child(text);
  }

  details(t) {
    const d = this.detail, pr = this.selected;
    const section = title => div().pt(8).font_semibold().text_color(t.foreground).child(title);
    const markdown = (id, body, limit) => TextView.markdown(id, body.length > limit ? body.slice(0, limit) + "\n\n… truncated for this preview" : body)
      .w_full().selectable(true).scrollable(false).text_size(12).text_color(t.foreground);
    const checks = d.statusCheckRollup.slice(0, 40), reviews = d.latestReviews.slice(-10), comments = d.comments.slice(-10);
    return v_flex().id(`pr-detail-${d.url}`).flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(10)
      .child(div().text_size(11).text_color(t.muted).child(`${pr.repository.nameWithOwner} #${d.number}`))
      .child(div().font_semibold().text_size(15).whitespace_normal().child(d.title))
      .child(div().text_size(11).text_color(t.accent).child(`${d.isDraft ? "Draft" : d.state} · @${d.author?.login ?? "unknown"}`))
      .child(div().text_size(11).text_color(t.muted).whitespace_normal().child(`${d.headRefName} → ${d.baseRefName}`))
      .child(h_flex().gap(12).text_size(12)
        .child(div().text_color(t.ansi2).child(`+${d.additions}`))
        .child(div().text_color(t.ansi1).child(`−${d.deletions}`))
        .child(div().text_color(t.muted).child(`${d.changedFiles} files`)))
      .child(div().text_size(11).text_color(t.muted).child(`Updated ${d.updatedAt.slice(0, 10)}`))
      .child(section("Review & merge status"))
      .child(div().text_size(12).text_color(t.muted).whitespace_normal()
        .child(`${(d.reviewDecision || "No review decision").replaceAll("_", " ").toLowerCase()} · ${(d.mergeable || "unknown").toLowerCase()}`))
      .child(section("Description"))
      .child(markdown(`pr-body-${d.url}`, d.body || "No description provided.", 24000))
      .child(section(`Checks (${d.statusCheckRollup.length})`))
      .children(checks.map((check, i) => v_flex().id(`check-${i}`).gap(2).py(4)
        .child(div().text_size(12).whitespace_normal().child(check.name || check.context || "Check"))
        .child(div().text_size(11).text_color(t.muted).child((check.conclusion || check.state || check.status || "unknown").replaceAll("_", " ").toLowerCase()))))
      .when(!checks.length, el => el.child(div().text_color(t.dim).child("No checks reported")))
      .when(d.statusCheckRollup.length > 40, el => el.child(div().text_color(t.dim).child("Showing the first 40 checks")))
      .child(section(`Latest reviews (${d.latestReviews.length})`))
      .children(reviews.map((review, i) => v_flex().id(`review-${i}`).gap(5).py(4)
        .child(div().text_size(11).text_color(t.muted).child(`@${review.author?.login ?? "unknown"} · ${(review.state || "reviewed").replaceAll("_", " ").toLowerCase()}`))
        .when(Boolean(review.body), el => el.child(markdown(`review-body-${d.url}-${i}`, review.body, 3000)))))
      .when(!reviews.length, el => el.child(div().text_color(t.dim).child("No reviews yet")))
      .when(d.latestReviews.length > 10, el => el.child(div().text_color(t.dim).child("Showing the latest 10 reviews")))
      .child(section(`Comments (${d.comments.length})`))
      .children(comments.map((comment, i) => v_flex().id(`comment-${i}`).gap(5).py(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(`@${comment.author?.login ?? "unknown"} · ${(comment.createdAt || "").slice(0, 10)}`))
        .child(markdown(`comment-body-${d.url}-${i}`, comment.body || "Empty comment", 4000))))
      .when(!comments.length, el => el.child(div().text_color(t.dim).child("No comments yet")))
      .when(d.comments.length > 10, el => el.child(div().text_color(t.dim).child("Showing the latest 10 comments")));
  }

  render() {
    const t = theme();
    return v_flex().id("github-prs").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border(1).border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.selected), el => el.child(this.button("github-back", "← All PRs", (_e, cx) => this.back(cx), t)))
        .child(div().font_semibold().child(this.selected ? `PR #${this.selected.number}` : "My PRs"))
        .child(div().flex_1())
        .child(this.button("github-refresh", "Refresh", (_e, cx) => this.load(this.selected, cx), t)))
      .when(Boolean(this.error), el => el.child(v_flex().p(14).gap(8)
        .child(div().text_color(t.ansi1).whitespace_normal().child(this.error))
        .child(div().text_color(t.muted).whitespace_normal().child("Check your connection and gh auth status, then Refresh."))))
      .when(this.loading, el => el.child(div().p(14).text_color(t.muted).child(this.selected ? "Loading pull request…" : "Loading your pull requests…")))
      .when(!this.loading && !this.error && Boolean(this.detail), el => el.child(this.details(t)))
      .when(!this.loading && !this.error && !this.selected, el => el.child(
        v_flex().id("github-pr-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8)
          .child(div().px(4).py(4).text_size(11).text_color(t.muted).child(`${this.prs.length} open · authored by you · all repositories`))
          .children(this.prs.map(pr => Button.new(`pr-${pr.url}`).w_full().flex_none().flex().flex_col().items_start()
            .p(10).gap(6).rounded(8).border(1).border_color(t.border).hover(s => s.bg(t.hover))
            .focus(s => s.border_color(t.accent)).accessibility_label(`${pr.repository.nameWithOwner} #${pr.number}: ${pr.title}`)
            .on_click((_e, cx) => this.load(pr, cx))
            .child(div().text_size(11).text_color(t.muted).whitespace_normal().child(`${pr.repository.nameWithOwner} #${pr.number}`))
            .child(div().w_full().text_size(13).font_semibold().text_color(t.foreground).whitespace_normal().child(pr.title))
            .child(div().text_size(11).text_color(pr.isDraft ? t.dim : t.ansi2).child(`${pr.isDraft ? "Draft" : "Open"} · ${(pr.updatedAt || "").slice(0, 10)}`))))
          .when(!this.prs.length, el => el.child(div().p(10).text_color(t.dim).child("You have no open pull requests.")))
          .when(this.prs.length === 30, el => el.child(div().p(4).text_color(t.dim).child("Showing the latest 30 open pull requests")))));
  }
}
