import os
from django.core.management.base import BaseCommand, CommandError
from binderbase.models import Protein, BinderRun


class Command(BaseCommand):
    help = "Import a binder design run directory into a BinderRun record"

    def add_arguments(self, parser):
        parser.add_argument("--run_dir", required=True, help="Path to the run directory (must contain steps.yaml)")
        parser.add_argument("--protein_uniprot", required=True, help="UniProt ID of the target protein")
        parser.add_argument("--algorithm_version", default=None)
        parser.add_argument("--description", default=None)
        parser.add_argument("--hardware", default=None)
        parser.add_argument("--notes", default=None)

    def handle(self, *args, **options):
        run_dir = os.path.abspath(options["run_dir"])

        if not os.path.isdir(run_dir):
            raise CommandError(f"run_dir does not exist: {run_dir}")
        if not os.path.isfile(os.path.join(run_dir, "steps.yaml")):
            raise CommandError(f"steps.yaml not found in: {run_dir}")

        protein, created = Protein.objects.get_or_create(
            uniprot_id=options["protein_uniprot"],
            defaults={"sequence": ""},
        )
        if created:
            self.stdout.write(f"Created Protein: {protein.uniprot_id} (sequence is empty — update it manually)")
        else:
            self.stdout.write(f"Found Protein: {protein.uniprot_id}")

        run = BinderRun.objects.create(
            protein=protein,
            run_dir=run_dir,
            algorithm_version=options["algorithm_version"],
            description=options["description"],
            hardware=options["hardware"],
            notes=options["notes"],
        )

        self.stdout.write(self.style.SUCCESS(f"Created BinderRun id={run.id}  run_dir={run_dir}"))
