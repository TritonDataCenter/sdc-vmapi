# Joyent Engineering Guide

Repository: <git@git.joyent.com:zapi.git>
Browsing: <https://mo.joyent.com/zapi>
Who: ?
Docs: <https://head.no.de/docs/zapi>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/ZAPI>


# Overview

TBD

# Repository

    deps/           Git submodules and/or commited 3rd-party deps should go
                    here. See "node_modules/" for node.js deps.
    docs/           Project docs (restdown)
    lib/            Source files.
    node_modules/   Node.js deps, either populated at build time or commited.
                    See Managing Dependencies.
    pkg/            Package lifecycle scripts
    smf/manifests   SMF manifests
    smf/methods     SMF method scripts
    test/           Test suite (using node-tap)
    tools/          Miscellaneous dev/upgrade/deployment tools and data.
    Makefile
    package.json    npm module info (holds the project version)
    README.md


# Development

To run the boilerplate API server:

    git clone git@git.joyent.com:eng.git
    cd eng
    git submodule update --init
    make all
    node server.js

To update the guidelines, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.



# Testing

    make test

If you project has setup steps necessary for testing, then describe those
here.



# Other Sections Here

Add other sections to your README as necessary. E.g. Running a demo, adding
development data.



# TODO

Remaining work for this repo:

- any "TODO" or "XXX" in the repo
- review from engineering group
- [Trent] Finish the restdown "public" dir and other work as discussed with
  Philip. `git rm docs/media/css`
- Give a little starter guide on using this repo as a starter template for the
  new repos (for NAPI, CNAPI, FWAPI, DAPI, Workflow API, ZAPI). Include
  getting on mo.joyent.com and head.no.de/docs for this.
- Should we spec JIRA projects for the new APIs?
- Add the node/npm local build support a la Amon and DSAPI. I.e. deps/node
  and deps/npm git submodules and build handling in the Makefile.

