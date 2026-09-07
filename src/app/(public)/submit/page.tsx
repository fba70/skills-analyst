import type { Metadata } from "next";

import { SubmitForm } from "@/components/registry/submit-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Suggest a repository" };

/**
 * R1.8's public half — anyone may suggest a repository.
 *
 * Admin submission and Settings → Add source have worked for months; what was missing was a
 * route for somebody who does not have an account, which is most of the people who know
 * where the good skills are.
 *
 * ## It queues, it does not promote
 *
 * `submitRepository` takes `autoPromote: false` here, which was anticipated in that file:
 * *"The public half of R1.8 will pass `false` here and reuse everything below unchanged."*
 * So a public submission lands as an ordinary discovery candidate and a curator decides. An
 * admin typing a repository name is the human look the large-repository gate exists to
 * require; a stranger pasting a URL is not.
 *
 * ## The page says what happens next, and what does not
 *
 * A submission form that says "thanks!" and nothing else trains people to expect their
 * suggestion appeared. This one states the two facts that matter: nothing is fetched until a
 * curator agrees, and the licence decides whether content can be mirrored at all.
 */
export default function SubmitPage() {
  return (
    <div className="grid max-w-2xl gap-6">
      <header className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Suggest a repository
        </h1>
        <p className="text-muted-foreground">
          If you know a repository with agent skills we have missed, paste it here. No account
          needed.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What happens to it</CardTitle>
          <CardDescription>
            It joins the discovery queue as a candidate. A curator decides before anything is
            fetched, so nothing you submit is downloaded, validated or indexed automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground grid gap-2 text-sm">
          <p>
            We read the repository&rsquo;s own licence before serving any of its content. An
            unlicensed repository is indexed as metadata only — name, description and a link
            back — because we are not in a position to redistribute what nobody granted.
          </p>
          <p>
            Every skill we do index keeps its provenance: the repository, the commit, the
            author and the licence, shown on its page.
          </p>
        </CardContent>
      </Card>

      <SubmitForm />
    </div>
  );
}
